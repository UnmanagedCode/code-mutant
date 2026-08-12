// The narrowing policy, at unit level. The end-to-end proof that file
// granularity is what keeps IMPRECISE detectable lives in
// narrowing-policy.test.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SHIPPED_ADAPTERS } from '../lib/adapters/index.mjs';
import { NarrowMode, planNarrowing } from '../lib/narrow.mjs';

const nodeTest = { ...SHIPPED_ADAPTERS['node-test'], name: 'node-test' };
const exitCode = { ...SHIPPED_ADAPTERS['exit-code'], name: 'exit-code' };
const TEST_COMMAND = 'node --test {tests}';

function mutant(extra = {}) {
  return {
    id: 'm', invariant: 'i', whyNotEquivalent: 'w', sites: [], narrowTo: 'file',
    expectFail: ['test/a.test.mjs::one'],
    expectPass: [],
    ...extra,
  };
}

describe('default: file granularity', () => {
  test('{tests} becomes the file, not the test names', () => {
    const plan = planNarrowing({ mutant: mutant(), adapter: nodeTest, testCommand: TEST_COMMAND });
    assert.equal(plan.mode, NarrowMode.FILE);
    assert.equal(plan.command, "node --test 'test/a.test.mjs'");
    assert.equal(plan.placeholder, true);
    assert.ok(!plan.command.includes('--test-name-pattern'), 'the default must not filter by name');
  });

  test('expectFail and expectPass files are unioned and de-duplicated', () => {
    const plan = planNarrowing({
      mutant: mutant({
        expectFail: ['test/a.test.mjs::one', 'test/b.test.mjs::two'],
        expectPass: ['test/a.test.mjs::three'],
      }),
      adapter: nodeTest,
      testCommand: TEST_COMMAND,
    });
    assert.deepEqual(plan.scopes, ['test/a.test.mjs', 'test/b.test.mjs']);
  });

  test('a testCommand with no placeholder is reported, not silently narrowed', () => {
    const plan = planNarrowing({ mutant: mutant(), adapter: nodeTest, testCommand: 'npm test' });
    assert.equal(plan.command, 'npm test');
    assert.equal(plan.placeholder, false);
  });

  test('counted mode with no references at all is refused', () => {
    assert.throws(
      () => planNarrowing({
        mutant: mutant({ expectFail: [], expectPass: [] }), adapter: nodeTest, testCommand: TEST_COMMAND,
      }),
      /cannot narrow without at least one entry/,
    );
  });
});

// Deliberately NOT 'node --test': substituteInto(TEST_COMMAND, '') trims
// 'node --test {tests}' down to that exact string too, so a fallback that wrongly
// re-derived the command from testCommand would be indistinguishable from a
// correct one that used baselineCommand -- a real, observed survivor. Using a
// baselineCommand whose text a testCommand substitution could never produce is
// what makes `command: baselineCommand` vs `substituteInto(testCommand, '')` a
// distinguishable mutant.
const LEARN_BASELINE_COMMAND = 'npm test';

describe('learn mode', () => {
  test('no refs + baselineCommand falls back to the whole suite, not a substitution', () => {
    const plan = planNarrowing({
      mutant: mutant({ expectFail: [], expectPass: [] }),
      adapter: nodeTest,
      testCommand: TEST_COMMAND,
      learn: true,
      baselineCommand: LEARN_BASELINE_COMMAND,
    });
    assert.equal(plan.command, LEARN_BASELINE_COMMAND);
    assert.equal(plan.mode, NarrowMode.WHOLE);
    assert.deepEqual(plan.scopes, []);
    // The mutant this pins flips this to true along with the command string.
    assert.equal(plan.placeholder, false);
  });

  test('non-learn with no refs still throws even when baselineCommand is supplied', () => {
    assert.throws(
      () => planNarrowing({
        mutant: mutant({ expectFail: [], expectPass: [] }),
        adapter: nodeTest,
        testCommand: TEST_COMMAND,
        learn: false,
        baselineCommand: LEARN_BASELINE_COMMAND,
      }),
      /cannot narrow without at least one entry/,
    );
  });

  test('learn with refs takes the ordinary file-narrowing path, not the fallback', () => {
    const plan = planNarrowing({
      mutant: mutant(),
      adapter: nodeTest,
      testCommand: TEST_COMMAND,
      learn: true,
      baselineCommand: LEARN_BASELINE_COMMAND,
    });
    assert.equal(plan.mode, NarrowMode.FILE);
    assert.equal(plan.command, "node --test 'test/a.test.mjs'");
  });
});

describe('opt-in name narrowing', () => {
  test('narrowTo:"names" filters by name and is flagged for the report', () => {
    const plan = planNarrowing({
      mutant: mutant({ narrowTo: 'names' }), adapter: nodeTest, testCommand: TEST_COMMAND,
    });
    assert.equal(plan.mode, NarrowMode.NAMES);
    assert.match(plan.command, /--test-name-pattern/);
    assert.equal(plan.requestedNames, true);
    assert.equal(plan.downgradeReason, null);
  });

  test('an adapter that cannot name-filter downgrades to file, with a stated reason', () => {
    const cannot = { ...nodeTest, canNameFilter: false, name: 'stubborn' };
    const plan = planNarrowing({
      mutant: mutant({ narrowTo: 'names' }), adapter: cannot, testCommand: TEST_COMMAND,
    });
    assert.equal(plan.mode, NarrowMode.FILE);
    assert.equal(plan.requestedNames, true);
    assert.match(plan.downgradeReason, /cannot filter by test name/);
  });

  test('references that name no individual test downgrade to file', () => {
    const plan = planNarrowing({
      mutant: mutant({ narrowTo: 'names', expectFail: ['test/a.test.mjs'] }),
      adapter: nodeTest,
      testCommand: TEST_COMMAND,
    });
    assert.equal(plan.mode, NarrowMode.FILE);
    assert.match(plan.downgradeReason, /no expectFail\/expectPass entry names an individual test/);
  });
});

describe('exit-code mode', () => {
  test('performs NO substitution -- the whole gate command runs', () => {
    const plan = planNarrowing({
      mutant: mutant({ expectFail: [] }), adapter: exitCode, testCommand: 'npx tsc --noEmit {tests}',
    });
    assert.equal(plan.mode, NarrowMode.WHOLE);
    assert.equal(plan.command, 'npx tsc --noEmit');
    assert.deepEqual(plan.scopes, []);
  });

  test('a name-narrowing request is refused with a reason rather than honoured', () => {
    const plan = planNarrowing({
      mutant: mutant({ narrowTo: 'names', expectFail: [] }), adapter: exitCode, testCommand: 'npm run snap',
    });
    assert.equal(plan.mode, NarrowMode.WHOLE);
    assert.match(plan.downgradeReason, /exit-code grade cannot filter by test name/);
  });
});

describe('narrowCommand', () => {
  test('overrides the substituted testCommand verbatim', () => {
    const plan = planNarrowing({
      mutant: mutant({ narrowCommand: 'npm run snap -- --grep home' }),
      adapter: nodeTest,
      testCommand: TEST_COMMAND,
    });
    assert.equal(plan.mode, NarrowMode.COMMAND);
    assert.equal(plan.command, 'npm run snap -- --grep home');
    assert.equal(plan.placeholder, false);
  });

  test('wins even in exit-code mode -- it is how a gate gets narrowed', () => {
    const plan = planNarrowing({
      mutant: mutant({ narrowCommand: 'npm run snap -- home', expectFail: [] }),
      adapter: exitCode,
      testCommand: 'npm run snap',
    });
    assert.equal(plan.mode, NarrowMode.COMMAND);
    assert.equal(plan.command, 'npm run snap -- home');
  });
});
