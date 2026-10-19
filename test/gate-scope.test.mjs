// The gates' route scope (lib/gate-scope.mjs): which routes a routed
// invocation's baseline and baseline-scope canary run. Pure -- no command runs.
//
// Invariant for the whole file: a route is left out of the gates only when no
// mutant in the invocation can run it, and that is decided only for a mutant
// whose routes are known statically; anything else gates every non-opt-in route.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { GateScopeReason, deriveGateScope, requestedGateRoutes, resolveGates } from '../lib/gate-scope.mjs';
import { ROUTE_EXEC_PATH, loadHarness } from '../lib/routing.mjs';

const ROUTES = [
  { name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test', baselineCommand: 'node --test test/', testCommand: 'node --test {tests}' },
  { name: 'other', tests: ['other/*.test.mjs'], runner: 'node-test', baselineCommand: 'node --test other/', testCommand: 'node --test {tests}' },
  { name: 'spec', tests: ['spec/*.spec.mjs'], runner: 'node-test', testCommand: 'node --test {tests}', optIn: true },
];

async function harness(routes = ROUTES) {
  return loadHarness({ routes, configDir: os.tmpdir(), baselineCommand: null, testCommand: null, runner: null });
}

async function plainHarness() {
  return loadHarness({
    configDir: os.tmpdir(), runner: 'node-test', baselineCommand: 'node --test', testCommand: 'node --test {tests}',
  });
}

const UNIT = (id, extra = {}) => ({ id, expectFail: ['test/guard.test.mjs::allows ollama'], ...extra });
const OTHER = (id) => ({ id, expectFail: ['other/a.test.mjs::a'] });
const SPEC = (id) => ({ id, expectFail: ['spec/a.spec.mjs::a'] });

async function derive(mutants, { learn = false, requested = null } = {}) {
  const { config, adapter } = await harness();
  return deriveGateScope({ adapter, config, mutants, learn, requested });
}

describe('deriveGateScope', () => {
  // Invariant: a FILE-narrowed mutant gates exactly the non-opt-in routes it runs.
  test('a file-narrowed mutant scopes the gates to its own route', async () => {
    const scope = await derive([UNIT('a')]);
    assert.equal(scope.reason, GateScopeReason.MUTANTS);
    assert.deepEqual(scope.routes, ['unit']);
  });

  // Invariant: names narrowing still names its route statically, so it scopes.
  test('a names-narrowed mutant scopes the gates to its own route', async () => {
    const scope = await derive([UNIT('a', { narrowTo: 'names' })]);
    assert.equal(scope.reason, GateScopeReason.MUTANTS);
    assert.deepEqual(scope.routes, ['unit']);
  });

  // Invariant: routing is a glob match on the path, so a ref to a file this
  // tree lacks still routes (its mutant ERRORs on its own scope).
  test('a ref naming a missing file still scopes', async () => {
    const scope = await derive([{ id: 'gone', expectFail: ['test/gone.test.mjs::x'] }]);
    assert.deepEqual(scope.routes, ['unit']);
  });

  // Invariant: --learn WITH refs narrows exactly like a graded run, so it scopes.
  test('--learn with refs scopes', async () => {
    const scope = await derive([UNIT('a')], { learn: true });
    assert.equal(scope.reason, GateScopeReason.MUTANTS);
    assert.deepEqual(scope.routes, ['unit']);
  });

  // Invariant: an opt-in route is never a gated route; a mutant running unit and
  // spec gates only unit.
  test('an opt-in route a mutant runs is not added to the gates', async () => {
    const scope = await derive([{ id: 'both', expectFail: ['test/guard.test.mjs::x', 'spec/a.spec.mjs::a'] }]);
    assert.deepEqual(scope.routes, ['unit']);
  });

  // Invariant: ONE unscopable mutant makes the whole invocation whole-harness,
  // and the detail names that mutant -- per-mutant narrowCommand case.
  test('a narrowCommand mutant beside a scoped one gates the whole harness', async () => {
    const scope = await derive([UNIT('a'), { id: 'cmd', narrowCommand: 'node --test test/', expectFail: ['test/guard.test.mjs::x'] }]);
    assert.equal(scope.routes, null);
    assert.equal(scope.reason, GateScopeReason.UNSCOPABLE_MUTANT);
    assert.match(scope.detail, /\bcmd\b/);
  });

  // Invariant: the --learn no-refs fallback runs the whole baselineCommand, so
  // it gates the whole harness.
  test('--learn with no refs gates the whole harness', async () => {
    const scope = await derive([UNIT('a'), { id: 'bare' }], { learn: true });
    assert.equal(scope.routes, null);
    assert.equal(scope.reason, GateScopeReason.UNSCOPABLE_MUTANT);
    assert.match(scope.detail, /\bbare\b/);
  });

  // Invariant: a mutant that fails to plan (no refs, or a ref no route owns)
  // gates the whole harness.
  for (const [name, bad] of [
    ['counted with no refs', { id: 'bad' }],
    ['a ref no route owns', { id: 'bad', expectFail: ['nowhere/x.test.mjs::x'] }],
  ]) {
    test(`${name}: gates the whole harness`, async () => {
      const scope = await derive([UNIT('a'), bad]);
      assert.equal(scope.routes, null);
      assert.equal(scope.reason, GateScopeReason.UNSCOPABLE_MUTANT);
      assert.match(scope.detail, /\bbad\b/);
    });
  }

  // Invariant: the baseline needs at least one route, so a catalog routed only
  // to opt-in routes gates the whole harness.
  test('every mutant only in opt-in routes gates the whole harness', async () => {
    const scope = await derive([SPEC('s')]);
    assert.equal(scope.routes, null);
    assert.equal(scope.reason, GateScopeReason.OPT_IN_ONLY);
  });

  // Invariant: a union covering every non-opt-in route IS the whole harness --
  // same key and same records as an unscoped run.
  test('a union equal to every non-opt-in route normalizes to the whole harness', async () => {
    const scope = await derive([UNIT('a'), OTHER('b')]);
    assert.equal(scope.routes, null);
    assert.equal(scope.reason, GateScopeReason.MUTANTS);
  });

  // Invariant: no mutants and no --route gates the whole harness.
  test('no mutants gates the whole harness', async () => {
    const scope = await derive([]);
    assert.equal(scope.routes, null);
    assert.equal(scope.reason, GateScopeReason.NO_MUTANTS);
  });

  // Invariant: --route names the scope directly.
  test('a requested route list scopes to it', async () => {
    const scope = await derive([], { requested: ['other'] });
    assert.equal(scope.reason, GateScopeReason.ROUTE_FLAG);
    assert.deepEqual(scope.routes, ['other']);
  });
});

describe('requestedGateRoutes', () => {
  // Invariant: an unknown name is refused and the refusal names the routes
  // that may be gated.
  test('an unknown route is refused, naming the known non-opt-in routes', async () => {
    const { adapter } = await harness();
    assert.throws(() => requestedGateRoutes(adapter, ['nope']), (err) => {
      assert.match(err.message, /nope/);
      assert.match(err.message, /unit/);
      assert.match(err.message, /other/);
      return true;
    });
  });

  // Invariant: an opt-in route has no baselineCommand, so it cannot be gated.
  test('an opt-in route is refused', async () => {
    const { adapter } = await harness();
    assert.throws(() => requestedGateRoutes(adapter, ['spec']), /opt-in/);
  });

  // Invariant: --route is meaningless without routes.
  test('a harness with no routes refuses --route', async () => {
    const { adapter } = await plainHarness();
    assert.throws(() => requestedGateRoutes(adapter, ['unit']), /routes/);
  });

  // Invariant: duplicates collapse and the order is the declared one, so two
  // spellings of one scope share a cache key.
  test('dedupes and returns declared order', async () => {
    const { adapter } = await harness();
    assert.deepEqual(requestedGateRoutes(adapter, ['other', 'unit', 'other']), ['unit', 'other']);
  });

  // Invariant: naming every non-opt-in route is the whole harness.
  test('every non-opt-in route named is the whole harness', async () => {
    const { config, adapter } = await harness();
    const requested = requestedGateRoutes(adapter, ['unit', 'other']);
    assert.equal(deriveGateScope({ adapter, config, mutants: [], requested }).routes, null);
  });
});

describe('resolveGates', () => {
  // Invariant: a scoped gate command runs only the gated routes' baselineCommands,
  // and every route left out is reported, opt-in first, then out-of-scope.
  test('scoped: only the gated pairs run, and the rest are reported skipped', async () => {
    const { config, adapter } = await harness();
    const gates = resolveGates({ adapter, config, routes: ['other'] });
    assert.ok(gates.baselineCommand.includes(ROUTE_EXEC_PATH));
    assert.ok(gates.baselineCommand.includes('node --test other/'));
    assert.ok(!gates.baselineCommand.includes('node --test test/'));
    assert.deepEqual(gates.routes.map((route) => route.name), ['other']);
    assert.deepEqual(gates.gateRoutes, ['other']);
    assert.deepEqual(gates.skippedRoutes, [
      { route: 'spec', runner: 'node-test', reason: 'opt-in' },
      { route: 'unit', runner: 'node-test', reason: 'out-of-scope' },
    ]);
  });

  // Invariant: whole scope is byte-identical to today's gate.
  test('whole: the loaded baselineCommand and only opt-in skips', async () => {
    const { config, adapter } = await harness();
    const gates = resolveGates({ adapter, config, routes: null });
    assert.equal(gates.baselineCommand, config.baselineCommand);
    assert.deepEqual(gates.routes.map((route) => route.name), ['unit', 'other']);
    assert.equal(gates.gateRoutes, null);
    assert.deepEqual(gates.skippedRoutes, [{ route: 'spec', runner: 'node-test', reason: 'opt-in' }]);
  });

  // Invariant: a single-runner harness is untouched.
  test('single runner: the configured baselineCommand, no routes, no skips', async () => {
    const { config, adapter } = await plainHarness();
    assert.deepEqual(resolveGates({ adapter, config, routes: null }), {
      baselineCommand: 'node --test', routes: null, skippedRoutes: [], gateRoutes: null,
    });
  });
});
