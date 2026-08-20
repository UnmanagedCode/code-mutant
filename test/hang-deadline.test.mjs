// THE ADAPTIVE HANG DEADLINE, and its mirror.
//
// A hung command used to cost the whole configured ceiling -- measured at 307x
// the same scope's own unmutated duration. It has a like-for-like reference in
// hand (that scope, unmutated, measured moments earlier), so the deadline comes
// from the reference and only a command with no reference falls back to the
// ceiling.
//
// Two directions are pinned here, and the second is the one nothing else would
// catch: the deadline FIRING (claims 1-3), and the deadline NOT firing on a mutant
// that legitimately runs slower than its reference (claim 3B). Get the tuning
// wrong in that second direction and a gradeable mutant silently becomes an
// ungraded TIMEOUT -- a verdict regression against today's behaviour, invisible to
// every test that only checks that hangs are caught.
//
// Wall time is asserted in exactly two machine-independent shapes: an upper bound
// on a deadline-killed command (a kill-happened assertion, against a ceiling
// orders of magnitude larger), and a ratio between two measurements from the same
// run driven by a fixed iteration count. No sleeps.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { Reason, Verdict } from '../lib/classify.mjs';
import { hangDeadlineMs } from '../lib/measure.mjs';
import { toJson } from '../lib/report.mjs';
import { GUARD_SOURCE, GUARD_TESTS, guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');
const SLOW = path.join(HERE, 'helpers', 'slow-when-mutated.mjs');

const MUTANT = {
  id: 'hangs',
  invariant: 'the user-defined-backend branch is load-bearing',
  sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
  expectPass: [],
  whyNotEquivalent: 'denies a backend the guard must admit',
};

async function run(repo, { env = {}, mutants = [MUTANT] } = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const config = loadConfig({ repoRoot: repo.root });
    const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
    // `await`, not a bare `return`: an async function's `finally` runs before an
    // un-awaited returned promise settles, which would restore the environment
    // before a single command had read it.
    return await execute({ config, adapter, mutants });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('the adaptive hang deadline', () => {
  test('1: a hung mutant is killed at the derived deadline, not the ceiling', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-hang-'));
    // floorMs: 0 so the factor branch is the one under test, and the ceiling is
    // 60s so a kill at the ceiling would be unmistakable.
    const repo = makeRepo({
      files: guardFiles(),
      config: {
        baselineCommand: 'node --test',
        testCommand: `node ${JSON.stringify(STAGED)} {tests}`,
        isolation: 'copy',
        timeoutMs: 60_000,
        hang: { factor: 4, floorMs: 0 },
      },
      label: 'hang-mutation',
    });
    try {
      // Invocation 1 is the narrow baseline and returns green; invocation 2 is the
      // mutant run and blocks on a timer that never fires. NOTHING but a deadline
      // kill can end it, so the sub-5s completion is attributable to nothing else.
      const report = await run(repo, {
        env: { CM_FAKE_STATE: path.join(scratch, 'invocations'), CM_FAKE_BLOCK_ON: '2' },
      });
      const result = report.results[0];

      assert.equal(result.verdict, Verdict.TIMEOUT, result.detail);
      assert.equal(result.reason, Reason.TIMED_OUT);
      assert.equal(result.hang.blame, 'mutation');

      // Exact, and derived from two numbers in this same report -- so it pins the
      // arithmetic without depending on how fast the machine is.
      const reference = report.narrowBaselines[0].durationMs;
      assert.equal(result.hang.referenceMs, reference);
      assert.equal(result.hang.deadlineMs, Math.ceil(4 * reference));
      assert.equal(result.deadlineMs, Math.ceil(4 * reference));

      assert.ok(result.measureMs < 5000, `killed at ${result.measureMs}ms against a 60000ms ceiling`);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('2: a suite that hangs on its own is blamed on the suite, not the mutation', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-hang-'));
    const repo = makeRepo({
      files: guardFiles(),
      config: {
        baselineCommand: 'node --test',
        testCommand: `node ${JSON.stringify(STAGED)} {tests}`,
        isolation: 'copy',
        timeoutMs: 1000,
        hang: { factor: 4, floorMs: 0 },
      },
      label: 'hang-suite',
    });
    try {
      // Invocation 1 IS the narrow baseline, so the unmutated scope is what hangs.
      const report = await run(repo, {
        env: { CM_FAKE_STATE: path.join(scratch, 'invocations'), CM_FAKE_BLOCK_ON: '1' },
      });
      const result = report.results[0];

      assert.equal(result.verdict, Verdict.ERROR, result.detail);
      assert.notEqual(result.verdict, Verdict.TIMEOUT, 'a mutation that was never measured cannot be blamed');
      assert.equal(result.reason, Reason.SCOPE_TIMED_OUT);
      assert.equal(result.hang.blame, 'suite');
      // A narrow baseline has no like-for-like reference, so it runs at the
      // ceiling and says so rather than implying a derivation that never happened.
      assert.equal(result.hang.referenceMs, null);
      assert.equal(result.hang.deadlineMs, 1000);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('3: hangDeadlineMs never exceeds timeoutMs and never drops below floorMs', () => {
    const rows = [
      { why: 'factor 0 disables the adaptive path', args: { referenceMs: 50, factor: 0, floorMs: 300, timeoutMs: 9000 }, expect: 9000 },
      { why: 'a tiny reference lands on the floor', args: { referenceMs: 5, factor: 4, floorMs: 300, timeoutMs: 9000 }, expect: 300 },
      { why: 'a huge reference is capped by the ceiling', args: { referenceMs: 100_000, factor: 4, floorMs: 300, timeoutMs: 9000 }, expect: 9000 },
      { why: 'a mid reference is factor x reference', args: { referenceMs: 500, factor: 4, floorMs: 300, timeoutMs: 9000 }, expect: 2000 },
      { why: 'floorMs 0 applies no floor at all', args: { referenceMs: 5, factor: 4, floorMs: 0, timeoutMs: 9000 }, expect: 20 },
      { why: 'a fractional product rounds up, never to zero', args: { referenceMs: 0.4, factor: 1, floorMs: 0, timeoutMs: 9000 }, expect: 1 },
    ];
    for (const row of rows) {
      assert.equal(hangDeadlineMs(row.args), row.expect, row.why);
    }
  });

  test('3B: THE MIRROR -- a mutant that legitimately runs slower than its reference still grades', async () => {
    // The mutated tree costs 4x the unmutated one, by iteration count. With
    // factor 20 the deadline is ~20x the reference, so a 4x run sits well inside
    // it -- and the assertion below proves it really was 4x rather than fast.
    const repo = makeRepo({
      files: { 'src/guard.mjs': GUARD_SOURCE, 'test/guard.test.mjs': GUARD_TESTS },
      config: {
        baselineCommand: 'node --test',
        testCommand: `node ${JSON.stringify(SLOW)}`,
        isolation: 'copy',
        timeoutMs: 60_000,
        hang: { factor: 20, floorMs: 0 },
      },
      label: 'hang-mirror',
    });
    try {
      const report = await run(repo, {
        env: {
          CM_SLOW_FILE: 'src/guard.mjs',
          CM_SLOW_NEEDLE: 'return false;',
          CM_SLOW_ITERATIONS: '12000000',
          CM_SLOW_FAIL_TEST: 'test/guard.test.mjs::allows user-defined backends',
        },
      });
      const result = report.results[0];

      // Graded exactly as it would be today.
      assert.equal(result.verdict, Verdict.KILLED, result.detail);
      assert.equal(result.hang, null, 'a graded mutant carries no hang record');
      assert.equal(toJson(report).results[0].graded, true);

      // THE CLAUSE THAT MAKES THIS NON-VACUOUS. A ratio of two measurements from
      // one run on one machine: it proves the mutant run took a real multiple of
      // its own reference -- i.e. it was inside the zone a badly-tuned deadline
      // would have killed -- and still graded. A test that merely ran fast fails
      // here. Nominal is 4x; asserted at 2.5x for scheduler headroom.
      const reference = report.narrowBaselines[0].durationMs;
      assert.ok(
        result.measureMs >= 2.5 * reference,
        `mutant run ${result.measureMs}ms was not a real multiple of its ${reference}ms reference`,
      );
      assert.ok(result.deadlineMs > result.measureMs, `${result.deadlineMs} <= ${result.measureMs}`);
    } finally { repo.cleanup(); }
  });
});
