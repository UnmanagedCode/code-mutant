// Opt-in routes (`"optIn": true`). Invariant for the whole file: an opt-in route
// is left out of the whole-suite baseline and the baseline-scope canary, runs only
// when a ref names a file it owns, and then gets every narrow gate -- it can only
// ever make a verdict harder to get.
//
// Route "spec" is a real node-test route; spec/broken.spec.mjs is red, so any
// baseline that ran the route would fail. "empty" and "canned" print canned output.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { baselineCanaryCovers, needsNarrowCanary } from '../lib/canary-gate.mjs';
import { formatReport } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

const CANNED = "process.stdout.write('✔ canned (1ms)\\nℹ tests 1\\nℹ suites 0\\nℹ pass 1\\nℹ fail 0\\n');\n";
const ZERO = "process.stdout.write('ℹ tests 0\\nℹ suites 0\\nℹ pass 0\\nℹ fail 0\\n');\n";

const UNIT = {
  name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test',
  baselineCommand: "node --test 'test/*.test.mjs'", testCommand: 'node --test {tests}',
};
const SPEC = { name: 'spec', tests: ['spec/*.spec.mjs'], runner: 'node-test', testCommand: 'node --test {tests}', optIn: true };
const EMPTY = { name: 'empty', tests: ['empty/*.spec.mjs'], runner: 'node-test', testCommand: 'node tools/zero.mjs {tests}', optIn: true };
const CANNED_ROUTE = {
  name: 'canned', tests: ['canned/*.spec.mjs'], runner: 'node-test', testCommand: 'node tools/canned.mjs {tests}', optIn: true,
};

const SPEC_GUARD = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "import { isAllowed } from '../src/guard.mjs';\n"
  + "test('spec allows ollama', () => { assert.equal(isAllowed('ollama'), true); });\n";
const SPEC_BROKEN = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "test('spec is red', () => { assert.equal(1, 2); });\n";
const STUB = "import { test } from 'node:test';\ntest('stub', () => {});\n";

const SITE = { file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' };
const OLLAMA_SITE = { file: 'src/guard.mjs', anchor: "if (kind === 'ollama') return true;", replacement: "if (kind === 'ollama') return false;" };
const UNIT_REF = 'test/guard.test.mjs::allows user-defined backends';

function mutant(id, extra = {}) {
  return { id, invariant: 'i', whyNotEquivalent: 'w', sites: [SITE], ...extra };
}

function optInRepo(label, mutants = null, routes = [UNIT, SPEC]) {
  const files = guardFiles();
  files['spec/guard.spec.mjs'] = SPEC_GUARD;
  files['spec/broken.spec.mjs'] = SPEC_BROKEN;
  files['empty/a.spec.mjs'] = STUB;
  files['canned/a.spec.mjs'] = STUB;
  files['src/wired.mjs'] = 'export const wired = () => 1;\n';
  files['spec/wired.spec.mjs'] = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { wired } from '../src/wired.mjs';\ntest('wired is 1', () => { assert.equal(wired(), 1); });\n";
  files['tools/zero.mjs'] = ZERO;
  files['tools/canned.mjs'] = CANNED;
  return makeRepo({
    files,
    config: { baselineCommand: undefined, testCommand: undefined, runner: undefined, routes },
    mutants,
    label,
  });
}

async function runJson(repo, args) {
  const result = await runCli([...args, '--json'], { cwd: repo.root });
  assert.ok(result.stdout.trim().startsWith('{'), `${result.stdout}\n${result.stderr}`);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
}

const byId = (report) => Object.fromEntries(report.results.map((r) => [r.id, r]));
const SKIPPED = [{ route: 'spec', runner: 'node-test', reason: 'opt-in' }];

describe('baseline skips an opt-in route', () => {
  // Invariant: the whole-suite baseline and its canary never run an opt-in route
  // (the red spec would fail them) and say so in `skippedRoutes`, not in groups.
  test('baseline and baseline-scope canary run only the other routes and report the skipped one', async () => {
    const repo = optInRepo('optin-baseline');
    try {
      const { exitCode, report } = await runJson(repo, ['baseline']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      const { baseline, canary } = report.gates;
      assert.equal(baseline.outcome, 'passed', baseline.detail);
      assert.deepEqual(baseline.groups.map((g) => g.route), ['unit']);
      assert.deepEqual(baseline.skippedRoutes, SKIPPED);
      assert.equal(canary.scope, 'baseline');
      assert.deepEqual(canary.routes.map((r) => [r.route, r.status]), [['unit', 'KILLED']]);
      assert.deepEqual(canary.skippedRoutes, SKIPPED);
      assert.deepEqual(report.adapter.routes.map((r) => [r.name, r.optIn === true]), [['unit', false], ['spec', true]]);

      const printed = formatReport(report);
      assert.equal(printed.match(/- spec\s+SKIPPED/g)?.length, 2, 'once under each gate');
      assert.doesNotMatch(printed, /spec {2}green/);
      assert.match(printed, /spec=node-test \[spec\/\*\.spec\.mjs\] \(opt-in\)/);
    } finally { repo.cleanup(); }
  });

  // Invariant: a routed config with no opt-in route keeps its report shape.
  test('no opt-in route: no skippedRoutes on either gate', async () => {
    const repo = optInRepo('optin-shape', null, [UNIT]);
    try {
      const { report } = await runJson(repo, ['baseline']);
      assert.equal('skippedRoutes' in report.gates.baseline, false);
      assert.equal('skippedRoutes' in report.gates.canary, false);
    } finally { repo.cleanup(); }
  });
});

describe('narrow gates hold on an opt-in route', () => {
  // Invariant: a mutant naming an opt-in file is gated by that route's own
  // narrow baseline (green, ran > 0) and its own canary.
  test('a green spec is canaried in the route and KILLS; a red or empty one ERRORs', async () => {
    const repo = optInRepo('optin-narrow', [
      mutant('green', { expectFail: ['spec/guard.spec.mjs::spec allows ollama'], sites: [OLLAMA_SITE] }),
      mutant('red', { expectFail: ['spec/broken.spec.mjs::spec is red'] }),
      mutant('zero', { expectFail: ['empty/a.spec.mjs::stub'] }),
    ], [UNIT, SPEC, EMPTY]);
    try {
      const { report } = await runJson(repo, ['run', '--all']);
      const results = byId(report);
      assert.equal(results.green.verdict, 'KILLED', results.green.detail);
      assert.deepEqual(results.green.narrowing.routes, ['spec']);
      assert.equal(results.red.verdict, 'ERROR');
      assert.equal(results.red.reason, 'scope-non-green');
      assert.equal(results.zero.verdict, 'ERROR');
      assert.equal(results.zero.reason, 'scope-empty');
      const scopes = report.gates.canary.scopes;
      const greenScope = scopes.find((s) => s.mutants.includes('green'));
      assert.deepEqual(greenScope.routes.map((r) => [r.route, r.status]), [['spec', 'KILLED']]);
      assert.equal(scopes.find((s) => s.mutants.includes('red')).skipped, 'narrow-baseline-not-green');
      assert.equal(repo.status(), '');
    } finally { repo.cleanup(); }
  });

  // Invariant: the canary must fire in the opt-in route itself; a route that
  // cannot observe a break refuses its mutant, beside a graded unit-only one.
  test('a route whose canary cannot fire ERRORs its mutant canary-not-established (PARTIAL)', async () => {
    const repo = optInRepo('optin-canned', [
      mutant('canned', { expectFail: ['canned/a.spec.mjs::canned'] }),
      mutant('unit-only', { expectFail: [UNIT_REF] }),
    ], [UNIT, CANNED_ROUTE]);
    try {
      const { report } = await runJson(repo, ['run', '--all']);
      const canary = report.gates.canary;
      assert.equal(canary.status, 'PARTIAL', canary.detail);
      const results = byId(report);
      assert.equal(results.canned.verdict, 'ERROR');
      assert.equal(results.canned.reason, 'canary-not-established');
      assert.match(canary.scopes.find((s) => s.mutants.includes('canned')).detail, /route "canned"/);
      assert.equal(results['unit-only'].verdict, 'KILLED', results['unit-only'].detail);
    } finally { repo.cleanup(); }
  });
});

describe('a command no narrow canary can attest', () => {
  const NAMES = mutant('names-spec', {
    narrowTo: 'names', expectFail: ['spec/guard.spec.mjs::spec allows ollama'], sites: [OLLAMA_SITE],
  });
  const COMMAND = mutant('command-spec', {
    narrowCommand: "node --test 'spec/guard.spec.mjs'", expectFail: ['spec/guard.spec.mjs::spec allows ollama'], sites: [OLLAMA_SITE],
  });

  // Invariant: the baseline-scope canary never runs an opt-in route, so a NAMES or
  // narrowCommand mutant that runs one is refused, never graded on a proxy.
  test('NAMES and narrowCommand opt-in mutants ERROR beside a graded unit-only mutant (PARTIAL)', async () => {
    const repo = optInRepo('optin-unattestable', [NAMES, COMMAND, mutant('unit-only', { expectFail: [UNIT_REF] })]);
    try {
      const { report } = await runJson(repo, ['run', '--all']);
      assert.equal(report.gates.canary.status, 'PARTIAL', report.gates.canary.detail);
      const results = byId(report);
      for (const id of ['names-spec', 'command-spec']) {
        assert.equal(results[id].verdict, 'ERROR', id);
        assert.equal(results[id].reason, 'canary-not-established', id);
        assert.match(results[id].detail, /opt-in route\(s\) spec/);
      }
      assert.equal(results['unit-only'].verdict, 'KILLED', results['unit-only'].detail);
      assert.match(formatReport(report), /^ {12}- .+ {3}NOT-ESTABLISHED {2}not attestable/m);
    } finally { repo.cleanup(); }
  });

  // Invariant: with nothing attestable at all the run is FAILED wholesale.
  test('alone they FAIL the gate: exit 2, no verdicts', async () => {
    const repo = optInRepo('optin-alone', [NAMES, COMMAND]);
    try {
      const { exitCode, report } = await runJson(repo, ['run', '--all']);
      assert.equal(exitCode, 2);
      assert.equal(report.gates.canary.status, 'FAILED');
      assert.deepEqual(report.results, []);
    } finally { repo.cleanup(); }
  });

  // Invariant: a canary cached by `baseline` is never served to a run whose
  // mutants include one the baseline-scope canary cannot attest.
  test('cache door: a baseline-written canary is not served to a NAMES opt-in mutant', async () => {
    const repo = optInRepo('optin-cache', [
      mutant('names-unit', { narrowTo: 'names', expectFail: [UNIT_REF] }),
      NAMES,
    ]);
    try {
      const first = await runJson(repo, ['baseline']);
      assert.equal(first.exitCode, 0);
      const { report } = await runJson(repo, ['run', '--id', 'names-unit', '--id', 'names-spec']);
      assert.equal(report.gateCache.status, 'hit');
      assert.equal(report.gateCache.canaryServed, false);
      const results = byId(report);
      assert.notEqual(results['names-unit'].verdict, 'ERROR', results['names-unit'].detail);
      assert.equal(results['names-spec'].verdict, 'ERROR');
      assert.equal(results['names-spec'].reason, 'canary-not-established');
    } finally { repo.cleanup(); }
  });
});

describe('--learn with no refs', () => {
  // Invariant: the whole-suite fallback never runs an opt-in route, so it must not
  // return a verdict (SURVIVED "nothing covers this") for a mutant only that
  // route covers; it ERRORs, naming the route.
  test('a no-ref mutant is plan-failed naming the opt-in route, never SURVIVED', async () => {
    const wired = { file: 'src/wired.mjs', anchor: '() => 1', replacement: '() => 2' };
    const repo = optInRepo('optin-learn', [mutant('only-spec', { sites: [wired] })]);
    try {
      const result = await runCli(['run', '--all', '--learn', '--json'], { cwd: repo.root });
      const [r] = JSON.parse(result.stdout).results;
      assert.equal(r.verdict, 'ERROR', r.detail);
      assert.equal(r.reason, 'plan-failed');
      assert.match(r.detail, /opt-in route\(s\) spec/);
    } finally { repo.cleanup(); }
  });
});

describe('baselineCanaryCovers / needsNarrowCanary', () => {
  const route = (name, optIn) => ({ name, optIn });
  const config = { baselineCommand: 'BASE' };
  const plain = { routes: [route('unit', false)] };
  const mixed = { routes: [route('unit', false), route('spec', true)] };

  // Invariant: the baseline-scope canary stands in only for commands that provably
  // run no opt-in route.
  test('covers exactly the narrowings that cannot run an opt-in route', () => {
    assert.equal(baselineCanaryCovers({ narrowing: { command: 'x', routes: ['unit'] }, adapter: plain, config }), true);
    assert.equal(baselineCanaryCovers({ narrowing: { command: 'x' }, adapter: { routes: undefined }, config }), true);
    assert.equal(baselineCanaryCovers({ narrowing: { command: 'x', routes: ['unit'] }, adapter: mixed, config }), true);
    assert.equal(baselineCanaryCovers({ narrowing: { command: 'x', routes: ['unit', 'spec'] }, adapter: mixed, config }), false);
    assert.equal(baselineCanaryCovers({ narrowing: { command: 'x' }, adapter: mixed, config }), false);
    assert.equal(baselineCanaryCovers({ narrowing: { command: 'BASE' }, adapter: mixed, config }), true);
  });

  test('a pending set holding only a NAMES opt-in entry needs a narrow canary', () => {
    const pending = [{ narrowing: { command: 'x', mode: 'names', routes: ['spec'], scopes: [] } }];
    assert.equal(needsNarrowCanary({ pending, adapter: mixed, config, workspaceRoot: '/nonexistent' }), true);
    assert.equal(needsNarrowCanary({ pending, adapter: plain, config, workspaceRoot: '/nonexistent' }), false);
  });
});
