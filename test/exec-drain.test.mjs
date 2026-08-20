// SETTLING ON `exit`, NOT ONLY ON `close`.
//
// `close` needs every holder of the stdout pipe gone, not just the child. A test
// command that backgrounds a worker inheriting stdout therefore left runCommand's
// promise unsettled until the timeout killed the group -- the command had finished
// long before. This is the exact failure class in the 2026-0183 evidence.
//
// Two directions, and the second is what keeps the first safe: settle early, AND
// never let settling early manufacture a green read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Reason, Verdict, classify } from '../lib/classify.mjs';
import { runCommand } from '../lib/exec.mjs';
import { isGreen } from '../lib/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEAKY = `node ${JSON.stringify(path.join(HERE, 'helpers', 'leaky-command.mjs'))}`;

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-drain-'));
  return { dir, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

describe('a command that exited but leaked a pipe holder', () => {
  test('6: settles at the drain grace, not at the ceiling', async () => {
    const s = scratch();
    try {
      // The grandchild lives 10s and the ceiling is 30s. Against the default 2s
      // grace, anything under 5s is attributable to the grace and to nothing else:
      // `close` cannot fire while the grandchild holds the pipe, so before this
      // change the only way out was the 30s timeout.
      const run = await runCommand(LEAKY, { cwd: s.dir, timeoutMs: 30_000 });

      assert.ok(run.durationMs < 5000, `settled after ${Math.round(run.durationMs)}ms against a 30000ms ceiling`);
      assert.equal(run.timedOut, false);
      assert.equal(run.exitCode, 0);
      // The command's own output was captured in full before it exited.
      assert.match(run.stdout, /ℹ pass 1/);
      assert.match(run.stdout, /ℹ fail 0/);
    } finally { s.cleanup(); }
  });

  test('7: settling early can never manufacture a green read', async () => {
    const s = scratch();
    try {
      // A grandchild that keeps WRITING is the case where an early settle really
      // does under-capture -- so the run must say so.
      const run = await runCommand(LEAKY, {
        cwd: s.dir,
        timeoutMs: 30_000,
        drainGraceMs: 50,
        env: { ...process.env, CM_LEAK_WRITE: '1', CM_LEAK_MS: '10000' },
      });

      assert.equal(run.outputIncomplete, true, 'an unclosed stream at grace expiry must be flagged');
      assert.equal(run.exitCode, 0);
      assert.ok(run.durationMs < 5000);

      // And the flag is load-bearing at both layers above: a run whose capture may
      // be short is not green, and it classifies ERROR rather than SURVIVED even
      // though zero failures were reported.
      assert.equal(isGreen({ run, parsed: { grade: 'counted', passed: 1, failed: 0, skipped: 0, ran: 1, failedTests: [], compileError: false } }), false);
    } finally { s.cleanup(); }
  });

  test('7b: a run flagged outputIncomplete classifies ERROR, never SURVIVED', () => {
    // Pure, so the branch is pinned independently of whether a subprocess can be
    // coaxed into producing it. Zero failures, exit 0 -- the exact input that
    // would otherwise read SURVIVED and publish a false finding.
    const classification = classify({
      run: {
        exitCode: 0, timedOut: false, spawnError: null, truncated: false, outputIncomplete: true, durationMs: 5,
      },
      parsed: {
        grade: 'counted', passed: 1, failed: 0, skipped: 0, ran: 1, failedTests: [], compileError: false,
      },
      expectFail: ['test/a.test.mjs::one'],
    });

    assert.equal(classification.verdict, Verdict.ERROR);
    assert.equal(classification.reason, Reason.OUTPUT_INCOMPLETE);
    assert.notEqual(classification.verdict, Verdict.SURVIVED);
  });

  test('7e: NO GRADE IS EXEMPT -- an under-captured exit-code run is ERROR, not a verdict', () => {
    // Claim 7b exercises only the COUNTED grade, so it survives the check being
    // moved below the exit-code grade split. It must not be: the exit-code branch
    // returns a verdict from the exit status alone, so an under-captured run
    // reaching it produces SURVIVED at exit 0 (a false finding -- the direction
    // this tool must never get wrong) or KILLED at non-zero (a fake-clean sweep).
    //
    // Reachable in production via an `exit-code` adapter and via the per-mutant
    // canary (lib/mutant-run.mjs). Pinned as a pure call for the same reason the
    // `truncated` counterpart is (test/classify.test.mjs, "a truncated
    // exit-code-mode capture is ERROR too -- no grade is exempt"): this is a
    // branch-ORDER property, and ordering is what a pure call pins exactly.
    const exitCodeParsed = { grade: 'exit-code', failedTests: [], compileError: false, ran: null };
    const rows = [
      { why: 'exit 0 would otherwise read SURVIVED -- a false finding', exitCode: 0 },
      { why: 'exit 1 would otherwise read KILLED -- a fake-clean sweep', exitCode: 1 },
    ];

    for (const row of rows) {
      const result = classify({
        run: {
          exitCode: row.exitCode,
          timedOut: false,
          spawnError: null,
          truncated: false,
          outputIncomplete: true,
          durationMs: 5,
        },
        parsed: exitCodeParsed,
        expectFail: ['test/a.test.mjs::one'],
      });

      assert.equal(result.verdict, Verdict.ERROR, row.why);
      assert.equal(result.reason, Reason.OUTPUT_INCOMPLETE, row.why);
      assert.notEqual(result.verdict, Verdict.SURVIVED, row.why);
      assert.notEqual(result.verdict, Verdict.KILLED, row.why);
    }

    // The control: the same grade, same exit codes, capture intact -> the ordinary
    // exit-code verdicts. Without this the assertions above would also pass if
    // exit-code mode had simply stopped producing verdicts at all.
    const intact = (exitCode) => classify({
      run: {
        exitCode, timedOut: false, spawnError: null, truncated: false, outputIncomplete: false, durationMs: 5,
      },
      parsed: exitCodeParsed,
      expectFail: ['test/a.test.mjs::one'],
    }).verdict;
    assert.equal(intact(0), Verdict.SURVIVED);
    assert.equal(intact(1), Verdict.KILLED);
  });

  test('7d: a high-volume run drains fully and is never flagged', async () => {
    // The specific risk in settling on `exit`: a legitimately slow-draining run
    // reading as incomplete. Structurally it cannot -- once the child has exited
    // nothing new is produced, and what remains is a pipe buffer that drains in
    // microseconds -- but "cannot" deserves evidence, so this writes ~4MB and then
    // exits, and asserts every byte arrived with no flag.
    const s = scratch();
    try {
      const run = await runCommand(
        `node -e "const line='x'.repeat(255)+String.fromCharCode(10); for(let i=0;i<16384;i++) process.stdout.write(line);"`,
        { cwd: s.dir, timeoutMs: 30_000 },
      );
      assert.equal(run.exitCode, 0);
      assert.equal(run.outputIncomplete, false, 'a large but complete capture must not be flagged');
      assert.equal(run.truncated, false);
      assert.equal(run.stdout.length, 16384 * 256, `captured ${run.stdout.length} of ${16384 * 256} bytes`);
    } finally { s.cleanup(); }
  });

  test('7c: a clean command is untouched -- complete output, no flag, no added latency', async () => {
    // The negative direction. Without this, a change that flagged EVERY run would
    // pass claims 6 and 7 and break every real verdict.
    const s = scratch();
    try {
      const run = await runCommand('printf "ok\\n"', { cwd: s.dir, timeoutMs: 30_000 });
      assert.equal(run.outputIncomplete, false);
      assert.equal(run.exitCode, 0);
      assert.equal(run.stdout, 'ok\n');
      // `close` fired on its own, so the 2s grace was never waited out.
      assert.ok(run.durationMs < 1000, `a clean command should not pay the drain grace (${run.durationMs}ms)`);
    } finally { s.cleanup(); }
  });
});
