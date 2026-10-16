// Mixed routing, proven end to end: a real `node --test` backend route and a
// real Vitest frontend route (this repo's pinned devDependency) in one temp git
// repo, driven through the real CLI and the full mutate cycle.
//
// Shaped like a project with a node backend suite plus a Vitest frontend suite
// under its own config: Vitest runs from the repo root with `--config`, and its
// config sets its own root and include. A shared module is used by both sides,
// so one mutant's narrowed command spans both routes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { REQUIRED_FLAGS } from '../lib/adapters/vitest.mjs';
import { formatReport } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { git } from './helpers/tmp-repo.mjs';
import { makeVitestRepo } from './helpers/vitest-project.mjs';

const VITEST = `node node_modules/vitest/vitest.mjs run --no-cache --no-fsModuleCache --config frontend/vitest.config.mjs ${REQUIRED_FLAGS}`;

const ROUTES = [
  {
    name: 'backend', tests: ['tests/*.test.mjs'], runner: 'node-test',
    baselineCommand: "node --test 'tests/*.test.mjs'", testCommand: 'node --test {tests}',
  },
  {
    name: 'frontend', tests: ['frontend/src/**/*.test.js'], runner: 'vitest',
    baselineCommand: VITEST, testCommand: `${VITEST} {tests}`,
  },
];

const FILES = {
  'shared/clamp.mjs': 'export function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\n',
  'src/guard.mjs': `import { clamp } from '../shared/clamp.mjs';

export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  return kind === 'user-defined';
}

export function retries(n) {
  return clamp(n, 0, 5);
}
`,
  'tests/guard.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, retries } from '../src/guard.mjs';

test('allows ollama', () => { assert.equal(isAllowed('ollama'), true); });
test('allows user-defined backends', () => { assert.equal(isAllowed('user-defined'), true); });
test('caps retries at 5', () => { assert.equal(retries(9), 5); });
`,
  'frontend/vitest.config.mjs': `import { fileURLToPath } from 'node:url';

export default { root: fileURLToPath(new URL('.', import.meta.url)), test: { include: ['src/**/*.test.js'] } };
`,
  'frontend/src/format.mjs': `import { clamp } from '../../shared/clamp.mjs';

export function percent(n) {
  return \`\${clamp(n, 0, 100)}%\`;
}

export function shout(text) {
  return text.toUpperCase();
}
`,
  'frontend/src/format.test.js': `import { describe, test, expect } from 'vitest';
import { percent } from './format.mjs';

describe('percent', () => {
  test('caps at 100', () => { expect(percent(150)).toBe('100%'); });
  test('formats', () => { expect(percent(42)).toBe('42%'); });
});
`,
};

const FRONT = 'frontend/src/format.test.js';
const MUTANTS = [
  {
    id: 'backend-killed', invariant: 'user-defined backends are allowed', whyNotEquivalent: 'denies an allowed backend',
    sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
    expectFail: ['tests/guard.test.mjs::allows user-defined backends'],
  },
  {
    id: 'frontend-killed', invariant: 'percent caps at 100', whyNotEquivalent: 'percent stops capping',
    sites: [{ file: 'frontend/src/format.mjs', anchor: '${clamp(n, 0, 100)}%', replacement: '${n}%' }],
    expectFail: [`${FRONT}::percent > caps at 100`],
    expectPass: [`${FRONT}::percent > formats`],
  },
  {
    id: 'frontend-survived', invariant: 'shout upper-cases', whyNotEquivalent: 'shout changes case',
    sites: [{ file: 'frontend/src/format.mjs', anchor: 'text.toUpperCase()', replacement: 'text.toLowerCase()' }],
    expectFail: [`${FRONT}::percent > formats`],
  },
  {
    id: 'cross', invariant: 'clamp caps at hi', whyNotEquivalent: 'clamp stops capping',
    sites: [{ file: 'shared/clamp.mjs', anchor: 'Math.min(hi, Math.max(lo, n))', replacement: 'Math.max(lo, n)' }],
    expectFail: ['tests/guard.test.mjs::caps retries at 5', `${FRONT}::percent > caps at 100`],
  },
];

function routedRepo(label, mutants = null) {
  return makeVitestRepo({
    files: FILES,
    config: { runner: undefined, baselineCommand: undefined, testCommand: undefined, routes: ROUTES },
    mutants,
    label,
  });
}

function trackedBytes(root) {
  return Object.fromEntries(git(root, ['ls-files']).split('\n').filter(Boolean)
    .map((file) => [file, readFileSync(path.join(root, file), 'utf8')]));
}

async function runJson(repo, args) {
  const result = await runCli([...args, '--json'], { cwd: repo.root, timeoutMs: 300_000 });
  assert.ok(result.stdout.trim().startsWith('{'), `expected a JSON report, got:\n${result.stdout}\n${result.stderr}`);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
}

describe('mixed node + Vitest routing, full mutate cycle', () => {
  // Invariant: mixed routing is Proven through every phase -- baseline per
  // route, canary per route, narrowing to the routes a mutant names, grading
  // the merged failures, restore and no-trace.
  test('run --all grades each route\'s mutants and one that spans both', async () => {
    const repo = routedRepo('routing-e2e', MUTANTS);
    try {
      const before = trackedBytes(repo.root);
      const { exitCode, report } = await runJson(repo, ['run', '--all']);

      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.deepEqual(
        report.gates.baseline.groups.map((g) => [g.route, g.green, g.counts.ran]),
        [['backend', true, 3], ['frontend', true, 2]],
      );

      const canary = report.gates.canary;
      assert.equal(canary.status, 'KILLED', canary.detail);
      for (const scope of canary.scopes) {
        assert.equal(scope.status, 'KILLED', scope.detail);
        for (const route of scope.routes) assert.equal(route.status, 'KILLED', route.detail);
      }
      const crossScope = canary.scopes.find((scope) => scope.mutants.includes('cross'));
      assert.deepEqual(crossScope.routes.map((r) => r.route), ['backend', 'frontend']);

      const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
      assert.equal(byId['backend-killed'].verdict, 'KILLED', byId['backend-killed'].detail);
      assert.equal(byId['frontend-killed'].verdict, 'KILLED', byId['frontend-killed'].detail);
      assert.equal(byId['frontend-survived'].verdict, 'SURVIVED', byId['frontend-survived'].detail);
      assert.equal(byId.cross.verdict, 'KILLED', byId.cross.detail);
      assert.deepEqual(byId['backend-killed'].narrowing.routes, ['backend']);
      assert.deepEqual(byId['frontend-killed'].narrowing.routes, ['frontend']);
      assert.deepEqual(byId.cross.narrowing.routes, ['backend', 'frontend']);
      assert.deepEqual(byId.cross.groups.map((g) => [g.route, g.counts.failed]), [['backend', 1], ['frontend', 1]]);

      // The survivor block says which runners judged it, and which never ran.
      assert.match(formatReport(report), /routes run: {3}frontend \(backend: no ref in scope\)/);

      assert.equal(exitCode, 1, 'a survivor exits 1');
      assert.deepEqual(trackedBytes(repo.root), before, 'the tree is byte-identical');
      assert.equal(repo.status(), '', 'git status is clean');
      assert.equal(existsSync(path.join(repo.root, '.vitest')), false);
      assert.equal(existsSync(path.join(repo.root, 'frontend', '.vitest')), false);
    } finally { repo.cleanup(); }
  });

  test('baseline establishes a baseline-scope canary in every route', async () => {
    const repo = routedRepo('routing-e2e-baseline');
    try {
      const { exitCode, report } = await runJson(repo, ['baseline']);
      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.equal(report.gates.canary.scope, 'baseline');
      assert.equal(report.gates.canary.status, 'KILLED', report.gates.canary.detail);
      assert.deepEqual(
        report.gates.canary.routes.map((r) => [r.route, r.status, r.target]),
        [['backend', 'KILLED', 'tests/guard.test.mjs'], ['frontend', 'KILLED', FRONT]],
      );
      assert.equal(exitCode, 0);
      assert.equal(repo.status(), '');
    } finally { repo.cleanup(); }
  });
});
