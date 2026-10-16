// The canary, per route. Invariant for the whole file: the canary must fire in
// EVERY route the judging command runs -- one route observing a deliberate
// break says nothing about a different runner reading different files.
//
// Route "spec" runs a command that prints canned, always-green node-test output
// whatever files it is given, so no canary can ever fire there.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { formatReport } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

const CANNED = "process.stdout.write('✔ canned (1ms)\\nℹ tests 1\\nℹ suites 0\\nℹ pass 1\\nℹ fail 0\\n');\n";

const ROUTES = [
  { name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test', baselineCommand: "node --test 'test/*.test.mjs'", testCommand: 'node --test {tests}' },
  { name: 'spec', tests: ['spec/*.spec.mjs'], runner: 'node-test', baselineCommand: 'node tools/canned.mjs', testCommand: 'node tools/canned.mjs {tests}' },
];

const SITE = { file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' };
const UNIT_REF = 'test/guard.test.mjs::allows user-defined backends';

function routedRepo(label, mutants = null) {
  const files = guardFiles();
  files['spec/b.spec.mjs'] = "import { test } from 'node:test';\ntest('canned', () => {});\n";
  files['tools/canned.mjs'] = CANNED;
  return makeRepo({
    files,
    config: { baselineCommand: undefined, testCommand: undefined, runner: undefined, routes: ROUTES },
    mutants,
    label,
  });
}

async function runJson(repo, args) {
  const result = await runCli([...args, '--json'], { cwd: repo.root });
  assert.ok(result.stdout.trim().startsWith('{'), `${result.stdout}\n${result.stderr}`);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
}

describe('canary per route', () => {
  test('a narrow scope spanning a route that cannot fire is unattested; one route alone is attested (PARTIAL)', async () => {
    const repo = routedRepo('canary-routes-narrow', [
      {
        id: 'spans-both', invariant: 'i', whyNotEquivalent: 'w', sites: [SITE],
        expectFail: [UNIT_REF], expectPass: ['spec/b.spec.mjs::canned'],
      },
      { id: 'unit-only', invariant: 'i', whyNotEquivalent: 'w', sites: [SITE], expectFail: [UNIT_REF] },
    ]);
    try {
      const { report } = await runJson(repo, ['run', '--all']);
      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      const canary = report.gates.canary;
      assert.equal(canary.status, 'PARTIAL', canary.detail);

      const [both, unitOnly] = canary.scopes;
      assert.equal(both.status, 'FAILED');
      assert.deepEqual(both.routes.map((r) => [r.route, r.status]), [['unit', 'KILLED'], ['spec', 'FAILED']]);
      assert.match(both.detail, /not attested: route "spec": /);
      assert.equal(unitOnly.status, 'KILLED');
      assert.deepEqual(unitOnly.routes.map((r) => [r.route, r.status]), [['unit', 'KILLED']]);

      const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
      assert.equal(byId['spans-both'].verdict, 'ERROR');
      assert.equal(byId['spans-both'].reason, 'canary-not-established');
      assert.equal(byId['unit-only'].verdict, 'KILLED', byId['unit-only'].detail);

      // The printed report names each route's own canary outcome.
      const printed = formatReport(report);
      assert.match(printed, /routes: unit=node-test \[test\/\*\.test\.mjs\]; spec=node-test \[spec\/\*\.spec\.mjs\]/);
      assert.match(printed, /- unit KILLED via test\/guard\.test\.mjs/);
      assert.match(printed, /- spec NOT FIRED {2}route "spec": /);
      assert.equal(repo.status(), '');
    } finally { repo.cleanup(); }
  });

  test('a baseline-scope canary is FAILED when one route cannot fire', async () => {
    const repo = routedRepo('canary-routes-baseline');
    try {
      const { exitCode, report } = await runJson(repo, ['baseline']);
      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      const canary = report.gates.canary;
      assert.equal(canary.scope, 'baseline');
      assert.equal(canary.status, 'FAILED');
      assert.deepEqual(canary.routes.map((r) => [r.route, r.status]), [['unit', 'KILLED'], ['spec', 'FAILED']]);
      assert.equal(canary.target, 'test/guard.test.mjs');
      assert.equal(exitCode, 2);
    } finally { repo.cleanup(); }
  });
});
