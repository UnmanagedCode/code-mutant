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
