// The five verdicts. Pure unit tests, since classify() takes everything as
// arguments -- no filesystem, no subprocess, no clock.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Reason, Verdict, classify, normalizeRef } from '../lib/classify.mjs';
import { countedResult } from '../lib/adapters/common.mjs';

const OK_RUN = { exitCode: 0, timedOut: false, spawnError: null, durationMs: 5 };
const FAIL_RUN = { exitCode: 1, timedOut: false, spawnError: null, durationMs: 5 };

function counted({ passed = 1, failed = 0, skipped = 0, ran = null, ids = [], compileError = false }) {
  return countedResult({
    passed,
    failed,
    skipped,
    ran: ran ?? passed + failed + skipped,
    compileError,
    failedTests: ids.map((id) => ({ file: id.split('::')[0], name: id.split('::')[1] ?? null, id })),
  });
}

describe('counted mode', () => {
  test('KILLED: exactly expectFail failed and expectPass held', () => {
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ passed: 2, failed: 1, ids: ['t.mjs::a'] }),
      expectFail: ['t.mjs::a'],
      expectPass: ['t.mjs::b'],
    });
    assert.equal(result.verdict, Verdict.KILLED);
    assert.equal(result.reason, null);
    assert.equal(result.grade, 'counted');
  });

  test('SURVIVED: nothing failed -- the finding', () => {
    const result = classify({
      run: OK_RUN,
      parsed: counted({ passed: 3 }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.SURVIVED);
    assert.deepEqual(result.missingFailures, ['t.mjs::a']);
    assert.match(result.detail, /passes either way/);
  });

  test('IMPRECISE: a compile break is not a coverage finding', () => {
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ passed: 0, failed: 1, compileError: true, ids: ['t.mjs::t.mjs'] }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.IMPRECISE);
    assert.equal(result.reason, Reason.COMPILE_ERROR);
  });

  test('IMPRECISE: an expectPass test broke', () => {
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ passed: 1, failed: 2, ids: ['t.mjs::a', 't.mjs::b'] }),
      expectFail: ['t.mjs::a'],
      expectPass: ['t.mjs::b'],
    });
    assert.equal(result.verdict, Verdict.IMPRECISE);
    assert.equal(result.reason, Reason.EXPECT_PASS_BROKE);
    assert.deepEqual(result.unexpectedFailures, ['t.mjs::b']);
  });

  test('IMPRECISE: failures outside expectFail -- the equivalent-mutant trap', () => {
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ passed: 0, failed: 2, ids: ['t.mjs::a', 't.mjs::unlisted'] }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.IMPRECISE);
    assert.equal(result.reason, Reason.EXTRA_FAILURES);
    assert.deepEqual(result.unexpectedFailures, ['t.mjs::unlisted']);
  });

  test('IMPRECISE: only part of expectFail failed -- an overstated claim, not a kill', () => {
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ passed: 1, failed: 1, ids: ['t.mjs::a'] }),
      expectFail: ['t.mjs::a', 't.mjs::b'],
    });
    assert.equal(result.verdict, Verdict.IMPRECISE);
    assert.equal(result.reason, Reason.PARTIAL_KILL);
    assert.deepEqual(result.missingFailures, ['t.mjs::b']);
  });

  test('ERROR: a scope that ran zero tests never reads SURVIVED', () => {
    const result = classify({
      run: OK_RUN,
      parsed: counted({ passed: 0, ran: 0 }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.ERROR);
    assert.equal(result.reason, Reason.SCOPE_EMPTY);
  });

  test('TIMEOUT is never counted as a kill', () => {
    const result = classify({
      run: { ...FAIL_RUN, timedOut: true, durationMs: 60_000 },
      parsed: counted({ passed: 0, failed: 0, ran: 0 }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.TIMEOUT);
    assert.equal(result.reason, Reason.TIMED_OUT);
  });

  test('a command that could not start is ERROR', () => {
    const result = classify({
      run: { ...FAIL_RUN, spawnError: 'ENOENT' },
      parsed: null,
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.ERROR);
    assert.equal(result.reason, Reason.COMMAND_FAILED_TO_START);
  });

  test('an empty expectFail treats any failure as extra rather than as a kill', () => {
    const killed = classify({ run: OK_RUN, parsed: counted({ passed: 2 }), expectFail: [] });
    assert.equal(killed.verdict, Verdict.SURVIVED);
    const noisy = classify({
      run: FAIL_RUN, parsed: counted({ failed: 1, ids: ['t.mjs::x'] }), expectFail: [],
    });
    assert.equal(noisy.verdict, Verdict.IMPRECISE);
    assert.equal(noisy.reason, Reason.EXTRA_FAILURES);
  });
});

describe('truncated capture', () => {
  test('a truncated counted-mode capture is ERROR even though the parsed data looks like a clean KILLED', () => {
    const result = classify({
      run: { ...FAIL_RUN, truncated: true },
      parsed: counted({ passed: 2, failed: 1, ids: ['t.mjs::a'] }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.ERROR);
    assert.equal(result.reason, Reason.OUTPUT_TRUNCATED);
  });

  test('a truncated exit-code-mode capture is ERROR too -- no grade is exempt', () => {
    const result = classify({
      run: { ...FAIL_RUN, truncated: true },
      parsed: { grade: 'exit-code', failedTests: [], compileError: false, ran: null },
      expectFail: ['whatever'],
    });
    assert.equal(result.verdict, Verdict.ERROR);
    assert.equal(result.reason, Reason.OUTPUT_TRUNCATED);
  });

  test('truncation is checked before timeout has a chance to mask it, but timeout still wins when both are true', () => {
    const result = classify({
      run: { ...FAIL_RUN, timedOut: true, truncated: true },
      parsed: counted({ passed: 0, ran: 0 }),
      expectFail: ['t.mjs::a'],
    });
    assert.equal(result.verdict, Verdict.TIMEOUT);
  });
});

describe('exit-code mode', () => {
  const parsed = { grade: 'exit-code', failedTests: [], compileError: false, ran: null };

  test('non-zero is KILLED, and the detail says precision was NOT established', () => {
    const result = classify({ run: FAIL_RUN, parsed, expectFail: ['whatever'] });
    assert.equal(result.verdict, Verdict.KILLED);
    assert.equal(result.grade, 'exit-code');
    assert.match(result.detail, /precision was NOT established/);
  });

  test('zero is SURVIVED', () => {
    const result = classify({ run: OK_RUN, parsed, expectFail: ['whatever'] });
    assert.equal(result.verdict, Verdict.SURVIVED);
    assert.equal(result.grade, 'exit-code');
  });

  test('IMPRECISE is unreachable here -- it is not detectable from an exit code', () => {
    for (const exitCode of [0, 1, 2, 127]) {
      const result = classify({ run: { ...OK_RUN, exitCode }, parsed, expectFail: ['x'] });
      assert.ok([Verdict.KILLED, Verdict.SURVIVED].includes(result.verdict));
    }
  });
});

describe('reference normalisation', () => {
  test('cosmetic differences are absorbed', () => {
    assert.equal(normalizeRef('./test/a.test.mjs::name '), 'test/a.test.mjs::name');
    assert.equal(normalizeRef('test//a.test.mjs'), 'test/a.test.mjs');
  });

  test('a file-only reference is NOT a wildcard for tests inside that file', () => {
    // Treating it as one would quietly weaken what KILLED means.
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ failed: 1, ids: ['t.mjs::some test'] }),
      expectFail: ['t.mjs'],
    });
    assert.equal(result.verdict, Verdict.IMPRECISE);
    assert.equal(result.reason, Reason.EXTRA_FAILURES);
  });

  test('a file-only reference matches a file-level failure', () => {
    const result = classify({
      run: FAIL_RUN,
      parsed: counted({ failed: 1, ids: ['t.mjs'] }),
      expectFail: ['t.mjs'],
    });
    assert.equal(result.verdict, Verdict.KILLED);
  });
});
