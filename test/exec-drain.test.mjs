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
