// Route-scoped trust gates, through the real CLI. Invariant for the whole file:
// a routed run's baseline and baseline-scope canary run only the routes its
// mutants can run; a mutant whose routes cannot be known statically gates every
// non-opt-in route; and a record measured for a subset of routes is never served
// as one for the whole harness.
//
// Route "other" is a real node-test route. In the red variant its own test
// fails, so any gate that ran it fails -- which is what makes scoping (and its
// over-application) observable from the exit code alone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { formatReport } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

const UNIT = {
  name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test',
  baselineCommand: "node --test 'test/*.test.mjs'", testCommand: 'node --test {tests}',
};
const OTHER = {
  name: 'other', tests: ['other/*.test.mjs'], runner: 'node-test',
  baselineCommand: "node --test 'other/*.test.mjs'", testCommand: 'node --test {tests}',
};
const SPEC = { name: 'spec', tests: ['spec/*.spec.mjs'], runner: 'node-test', testCommand: 'node --test {tests}', optIn: true };

const OTHER_RED = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "test('other is red', () => { assert.equal(1, 2); });\n";
const OTHER_GREEN = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "test('other is green', () => { assert.equal(1, 1); });\n";
const STUB = "import { test } from 'node:test';\ntest('stub', () => {});\n";

const SITE = { file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' };
const UNIT_REF = 'test/guard.test.mjs::allows user-defined backends';

const mutant = (id, extra = {}) => ({ id, invariant: 'i', whyNotEquivalent: 'w', sites: [SITE], ...extra });

const CATALOG = [
  mutant('unit', { expectFail: [UNIT_REF] }),
  mutant('names', { expectFail: [UNIT_REF], narrowTo: 'names' }),
  mutant('cmd', { expectFail: [UNIT_REF], narrowCommand: 'node --test test/guard.test.mjs' }),
  mutant('bare'),
  mutant('unrouted', { expectFail: ['nowhere/x.test.mjs::x'] }),
];

function scopedRepo(label, { otherRed = true } = {}) {
  const files = guardFiles();
  files['other/a.test.mjs'] = otherRed ? OTHER_RED : OTHER_GREEN;
  files['spec/a.spec.mjs'] = STUB;
  return makeRepo({
    files,
    config: { baselineCommand: undefined, testCommand: undefined, runner: undefined, routes: [UNIT, OTHER, SPEC] },
    mutants: CATALOG,
    label,
  });
}

async function runJson(repo, args) {
  const result = await runCli([...args, '--json'], { cwd: repo.root });
  assert.ok(result.stdout.trim().startsWith('{'), `${result.stdout}\n${result.stderr}`);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout), stderr: result.stderr };
}

const gateFiles = (repo) => readdirSync(path.join(repo.root, '.mutation', 'gates')).filter((f) => f.endsWith('.json'));
const OUT_OF_SCOPE_OTHER = { route: 'other', runner: 'node-test', reason: 'out-of-scope' };
const OPT_IN_SPEC = { route: 'spec', runner: 'node-test', reason: 'opt-in' };
const PROBE_ARGS = ['probe', '--file', SITE.file, '--anchor', SITE.anchor, '--replace', SITE.replacement, '--expect-fail', UNIT_REF];

describe('the gates run only the routes the mutants judge', () => {
  // Invariant: a red route no mutant runs cannot fail a run's gates, and is
  // reported SKIPPED out-of-scope, never among the gated groups.
  test('run: a mutant in unit is gated by unit alone, despite a red other', async () => {
    const repo = scopedRepo('rsg-run');
    try {
      const { exitCode, report } = await runJson(repo, ['run', '--id', 'unit']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      assert.equal(report.results[0].verdict, 'KILLED', report.results[0].detail);
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit']);
      assert.deepEqual(report.gates.baseline.skippedRoutes, [OPT_IN_SPEC, OUT_OF_SCOPE_OTHER]);
      assert.equal(report.gateScope.reason, 'mutants');
      assert.deepEqual(report.gateScope.routes, ['unit']);
    } finally { repo.cleanup(); }
  });

  // Invariant: probe derives its gate scope the same way run does.
  test('probe: an ad-hoc mutant in unit is gated by unit alone', async () => {
    const repo = scopedRepo('rsg-probe');
    try {
      const { exitCode, report } = await runJson(repo, PROBE_ARGS);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit']);
      assert.deepEqual(report.gates.baseline.skippedRoutes, [OPT_IN_SPEC, OUT_OF_SCOPE_OTHER]);
    } finally { repo.cleanup(); }
  });

  // Invariant (over-application guard): one mutant whose routes cannot be known
  // statically puts every non-opt-in route back in the gates, so the red route
  // fails them.
  for (const [name, args] of [
    ['a narrowCommand mutant', ['run', '--id', 'unit', '--id', 'cmd']],
    ['a --learn no-refs mutant', ['run', '--learn', '--id', 'unit', '--id', 'bare']],
    ['a mutant with an unrouted ref', ['run', '--id', 'unit', '--id', 'unrouted']],
  ]) {
    test(`${name} beside a unit mutant gates every route`, async () => {
      const repo = scopedRepo('rsg-whole');
      try {
        const { exitCode, report } = await runJson(repo, args);
        assert.equal(exitCode, 2, JSON.stringify(report.gates));
        assert.equal(report.gates.baseline.outcome, 'failed');
        assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit', 'other']);
        assert.equal(report.gateScope.reason, 'unscopable-mutant');
      } finally { repo.cleanup(); }
    });
  }

  // Invariant: the baseline-scope canary a names-mode mutant needs runs only the
  // gated routes, and the printed report never shows the left-out route green.
  test('a names-mode mutant: the baseline-scope canary runs only unit', async () => {
    const repo = scopedRepo('rsg-names', { otherRed: false });
    try {
      const { exitCode, report } = await runJson(repo, ['run', '--id', 'names']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      const { canary } = report.gates;
      assert.ok(['baseline', 'mixed'].includes(canary.scope), canary.scope);
      assert.deepEqual(canary.routes.map((r) => r.route), ['unit']);
      assert.deepEqual(canary.skippedRoutes, [OPT_IN_SPEC, OUT_OF_SCOPE_OTHER]);

      const printed = formatReport(report);
      assert.equal(printed.match(/- other\s+SKIPPED/g)?.length, 2, 'once under each gate');
      assert.doesNotMatch(printed, /other {2}green/);
      assert.match(printed, /gate scope: unit/);
    } finally { repo.cleanup(); }
  });
});

describe('baseline --route', () => {
  // Invariant: a bare baseline has no mutants to scope by, so it gates every route.
  test('a bare baseline gates every non-opt-in route', async () => {
    const repo = scopedRepo('rsg-bare');
    try {
      const { exitCode, report } = await runJson(repo, ['baseline']);
      assert.equal(exitCode, 2, JSON.stringify(report.gates));
      assert.equal(report.gateScope.reason, 'no-mutants');
    } finally { repo.cleanup(); }
  });

  // Invariant: --route scopes both gates of a bare baseline to the named routes.
  test('baseline --route unit gates unit alone', async () => {
    const repo = scopedRepo('rsg-route');
    try {
      const { exitCode, report } = await runJson(repo, ['baseline', '--route', 'unit']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit']);
      assert.deepEqual(report.gates.baseline.skippedRoutes, [OPT_IN_SPEC, OUT_OF_SCOPE_OTHER]);
      assert.deepEqual(report.gates.canary.routes.map((r) => r.route), ['unit']);
      assert.equal(report.gateScope.reason, 'route-flag');
    } finally { repo.cleanup(); }
  });

  // Invariant: a bad --route is a usage error before any gate runs.
  test('an unknown route is exit 4 and names the routes that can be gated', async () => {
    const repo = scopedRepo('rsg-unknown');
    try {
      const result = await runCli(['baseline', '--route', 'nope'], { cwd: repo.root });
      assert.equal(result.exitCode, 4, result.stderr);
      assert.match(result.stderr, /unit/);
      assert.match(result.stderr, /other/);
    } finally { repo.cleanup(); }
  });

  // Invariant: --route is refused for an opt-in route, outside `baseline`, and
  // in a harness with no routes.
  test('opt-in route, other commands and unrouted harnesses refuse --route', async () => {
    const repo = scopedRepo('rsg-refuse');
    const plain = makeRepo({ files: guardFiles(), label: 'rsg-plain' });
    try {
      for (const args of [['baseline', '--route', 'spec'], ['run', '--all', '--route', 'unit'], [...PROBE_ARGS, '--route', 'unit'],
        ['validate', '--route', 'unit'], ['candidates', '--base', 'master', '--route', 'unit']]) {
        const result = await runCli(args, { cwd: repo.root });
        assert.equal(result.exitCode, 4, `${args.join(' ')}: ${result.stderr}`);
        assert.match(result.stderr, /--route/);
      }
      const result = await runCli(['baseline', '--route', 'unit'], { cwd: plain.root });
      assert.equal(result.exitCode, 4, result.stderr);
    } finally { repo.cleanup(); plain.cleanup(); }
  });
});

describe('the gate cache under a route scope', () => {
  // Invariant: a subset measurement is never served as a whole-harness one.
  test('a scoped run does not satisfy a later bare baseline', async () => {
    const repo = scopedRepo('rsg-cache-subset', { otherRed: false });
    try {
      assert.equal((await runJson(repo, ['run', '--id', 'unit'])).exitCode, 0);
      const { report } = await runJson(repo, ['baseline']);
      assert.equal(report.gateCache.status, 'miss');
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit', 'other']);
    } finally { repo.cleanup(); }
  });

  // Invariant: a whole-harness entry satisfies a scoped lookup and promotes the
  // invocation to whole scope -- served verbatim, nothing relabelled, nothing written.
  test('a whole-harness entry serves a scoped run, which is then gated whole', async () => {
    const repo = scopedRepo('rsg-cache-whole', { otherRed: false });
    try {
      assert.equal((await runJson(repo, ['baseline', '--no-canary'])).exitCode, 0);
      const { exitCode, report } = await runJson(repo, ['run', '--id', 'unit']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      assert.equal(report.gateCache.status, 'hit');
      assert.equal(report.gateScope.reason, 'whole-cache-entry');
      assert.equal(report.gates.baseline.fromCache, true);
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit', 'other']);
      assert.equal(gateFiles(repo).length, 1);
    } finally { repo.cleanup(); }
  });

  // Invariant: after promotion, a canary filled into the whole entry is a
  // whole-scope canary, never a subset one.
  test('a promoted run fills the whole entry with a whole-scope canary', async () => {
    const repo = scopedRepo('rsg-cache-fill', { otherRed: false });
    try {
      assert.equal((await runJson(repo, ['baseline', '--no-canary'])).exitCode, 0);
      const { exitCode, report } = await runJson(repo, ['run', '--id', 'names']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      assert.equal(report.gateCache.filledCanary, true);
      const [file] = gateFiles(repo);
      const entry = JSON.parse(readFileSync(path.join(repo.root, '.mutation', 'gates', file), 'utf8'));
      assert.deepEqual(entry.gates.canary.routes.map((r) => r.route), ['unit', 'other']);
    } finally { repo.cleanup(); }
  });

  // Invariant: scoped --remeasure-gates skips BOTH lookups (it is neither served
  // nor promoted by the whole entry) and overwrites only its own scope's key.
  test('scoped --remeasure-gates re-measures and overwrites only the scoped entry', async () => {
    const repo = scopedRepo('rsg-cache-remeasure', { otherRed: false });
    try {
      // Scoped first: written after the whole entry, `baseline --route` would itself
      // be served (and promoted) by it.
      const scoped = await runJson(repo, ['baseline', '--route', 'unit', '--no-canary']);
      const whole = await runJson(repo, ['baseline', '--no-canary']);
      assert.equal(scoped.exitCode, 0);
      assert.equal(whole.exitCode, 0);
      assert.equal(scoped.report.gateScope.reason, 'route-flag');
      const bytes = (key) => readFileSync(path.join(repo.root, '.mutation', 'gates', `${key}.json`), 'utf8');
      const wholeBefore = bytes(whole.report.gateCache.key);
      const scopedBefore = JSON.parse(bytes(scoped.report.gateCache.key));

      const { exitCode, report } = await runJson(repo, ['run', '--id', 'unit', '--remeasure-gates']);
      assert.equal(exitCode, 0, JSON.stringify(report.gates));
      assert.equal(report.gateCache.status, 'bypassed');
      assert.equal(report.gateCache.key, scoped.report.gateCache.key);
      assert.equal(report.gateScope.reason, 'mutants');
      assert.equal(report.gates.baseline.fromCache, false);
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit']);

      assert.equal(gateFiles(repo).length, 2);
      assert.equal(bytes(whole.report.gateCache.key), wholeBefore, 'the whole-harness entry is untouched');
      const scopedAfter = JSON.parse(bytes(scoped.report.gateCache.key));
      assert.notEqual(scopedAfter.measuredAt, scopedBefore.measuredAt, 'the scoped entry was overwritten');
      assert.deepEqual(scopedAfter.keyInputs.gateRoutes, ['unit']);
    } finally { repo.cleanup(); }
  });

  // Invariant: a scoped entry is reused by a later invocation of the same scope.
  test('baseline --route unit serves a later run scoped to unit', async () => {
    const repo = scopedRepo('rsg-cache-scoped', { otherRed: false });
    try {
      const first = await runJson(repo, ['baseline', '--route', 'unit', '--no-canary']);
      assert.equal(first.exitCode, 0);
      const { report } = await runJson(repo, ['run', '--id', 'unit']);
      assert.equal(report.gateCache.status, 'hit');
      assert.equal(report.gateCache.key, first.report.gateCache.key);
      assert.equal(report.gateScope.reason, 'mutants');
      assert.deepEqual(report.gates.baseline.groups.map((g) => g.route), ['unit']);
    } finally { repo.cleanup(); }
  });
});
