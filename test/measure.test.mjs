// isGreen/describeNotGreen: pure, no filesystem or subprocess, so tested directly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { describeNotGreen, isGreen } from '../lib/measure.mjs';
import { countedResult } from '../lib/adapters/common.mjs';

const RUN = { exitCode: 0, timedOut: false, spawnError: null, truncated: false, durationMs: 5 };

describe('truncated captures are never green', () => {
  test('a truncated counted-mode run is not green even with a clean-looking parse', () => {
    const parsed = countedResult({ passed: 3, failed: 0, ran: 3, compileError: false });
    assert.equal(isGreen({ run: RUN, parsed }), true);
    assert.equal(isGreen({ run: { ...RUN, truncated: true }, parsed }), false);
  });

  test('a truncated exit-code-mode run is not green even with exit 0', () => {
    const parsed = { grade: 'exit-code', failedTests: [], compileError: false, ran: null };
    assert.equal(isGreen({ run: RUN, parsed }), true);
    assert.equal(isGreen({ run: { ...RUN, truncated: true }, parsed }), false);
  });

  test('describeNotGreen names truncation specifically, not a generic exit-code message', () => {
    const parsed = countedResult({ passed: 3, failed: 0, ran: 3, compileError: false });
    assert.match(describeNotGreen({ run: { ...RUN, truncated: true }, parsed }), /truncated/);
  });
});

describe('a counted command must agree with its own exit code', () => {
  const GREEN_COUNTS = countedResult({ passed: 3, failed: 0, ran: 3, compileError: false });

  test('a counted run that exits non-zero with zero parsed failures is not green', () => {
    // Both halves matter: dropping the exit-code check fails the first
    // assertion, and inverting it fails the second.
    assert.equal(isGreen({ run: { ...RUN, exitCode: 1 }, parsed: GREEN_COUNTS }), false);
    assert.equal(isGreen({ run: RUN, parsed: GREEN_COUNTS }), true);
  });

  test('describeNotGreen tells an unexplained non-zero exit apart from a zero-test scope', () => {
    const unexplained = describeNotGreen({ run: { ...RUN, exitCode: 1 }, parsed: GREEN_COUNTS });
    assert.match(unexplained, /zero test failures/);
    assert.doesNotMatch(unexplained, /ZERO tests/);

    // Ordering: a zero-test scope is the more specific diagnosis and keeps its
    // own wording even though the command also exited non-zero.
    const empty = countedResult({ passed: 0, failed: 0, ran: 0, compileError: false });
    assert.match(describeNotGreen({ run: { ...RUN, exitCode: 1 }, parsed: empty }), /ran ZERO tests/);
  });
});
