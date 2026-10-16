// The vitest adapter, proven end to end: real Vitest (this repo's pinned
// devDependency), a real temp git repo, the real CLI, the full mutate cycle.
//
// Every real run's report is larger than a pipe buffer (test/bulk.test.js), and
// the guard tests write to stdout with no trailing newline, so each verdict here
// is also read through the noise and the size the adapter has to survive.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runCli } from './helpers/cli.mjs';
import { git } from './helpers/tmp-repo.mjs';
import { bulkTests, makeVitestRepo } from './helpers/vitest-project.mjs';

const GUARD = `export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  return kind === 'user-defined';
}

export function label(kind) {
  return kind.toUpperCase();
}
`;

// One nested describe, and a sibling whose name EXTENDS another's -- the shape
// that tells an anchored -t apart from a substring one.
const GUARD_TESTS = `import { test, describe, expect } from 'vitest';
import { isAllowed } from '../src/guard.mjs';

process.stdout.write('guard-module-no-newline');

test('allows ollama', () => {
  console.log('console noise from a test');
  expect(isAllowed('ollama')).toBe(true);
});
describe('backends', () => {
  test('allows user-defined', () => {
    process.stdout.write('in-test-no-newline');
    expect(isAllowed('user-defined')).toBe(true);
  });
  test('allows user-defined two', () => { expect(isAllowed('user-defined')).toBe(true); });
});
test('rejects unknown', () => { expect(isAllowed('nope')).toBe(false); });
`;

const FILES = {
  'src/guard.mjs': GUARD,
  'test/guard.test.js': GUARD_TESTS,
  'test/bulk.test.js': bulkTests(),
};

const USER_DEFINED = 'test/guard.test.js::backends > allows user-defined';
const USER_DEFINED_TWO = 'test/guard.test.js::backends > allows user-defined two';

const KILLED = {
  id: 'killed',
  invariant: 'user-defined backends are allowed',
  sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
  expectFail: [USER_DEFINED, USER_DEFINED_TWO],
  expectPass: ['test/guard.test.js::allows ollama'],
  whyNotEquivalent: 'denies a backend the guard must admit',
};
const SURVIVED = {
  id: 'survived',
  invariant: 'label upper-cases its input',
  sites: [{ file: 'src/guard.mjs', anchor: 'kind.toUpperCase()', replacement: 'kind.toLowerCase()' }],
  expectFail: ['test/guard.test.js::rejects unknown'],
  whyNotEquivalent: 'label changes case',
};
// Names mode on the nested ref alone: KILLED only if -t selects exactly it --
// a selected sibling would also fail and read IMPRECISE.
const NAMES = {
  id: 'names',
  invariant: 'user-defined backends are allowed (name-scoped)',
  sites: KILLED.sites,
  expectFail: [USER_DEFINED],
  narrowTo: 'names',
  whyNotEquivalent: KILLED.whyNotEquivalent,
};

function trackedBytes(root) {
  return Object.fromEntries(git(root, ['ls-files']).split('\n').filter(Boolean)
    .map((file) => [file, readFileSync(path.join(root, file), 'utf8')]));
}

async function runJson(repo, args) {
  const result = await runCli([...args, '--json'], { cwd: repo.root, timeoutMs: 300_000 });
  assert.ok(result.stdout.trim().startsWith('{'), `expected a JSON report, got:\n${result.stdout}\n${result.stderr}`);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
}

describe('vitest adapter, full mutate cycle against real Vitest', () => {
  // Invariants: Vitest is Proven end to end; restore and no-trace hold; the
  // names -t filter matches a nested test and excludes a sibling that extends it.
  test('run --all in place grades KILLED / SURVIVED / KILLED and leaves no trace', async () => {
    const repo = makeVitestRepo({ files: FILES, mutants: [KILLED, SURVIVED, NAMES], label: 'vitest-e2e' });
    try {
      const before = trackedBytes(repo.root);
      const { exitCode, report } = await runJson(repo, ['run', '--all']);

      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.equal(report.gates.baseline.counts.ran, 2004);
      assert.equal(report.gates.canary.status, 'KILLED', report.gates.canary.detail);
      const narrowUnits = report.gates.canary.scopes.filter((scope) => !scope.skipped);
      assert.ok(narrowUnits.length >= 1);
      for (const unit of narrowUnits) assert.equal(unit.status, 'KILLED', unit.detail);

      const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
      assert.equal(byId.killed.verdict, 'KILLED', byId.killed.detail);
      assert.equal(byId.survived.verdict, 'SURVIVED', byId.survived.detail);
      assert.equal(byId.names.verdict, 'KILLED', byId.names.detail);
      assert.equal(byId.names.narrowing.mode, 'names');
      // Exactly one test selected -- not its sibling 'allows user-defined two'; the
      // other three in the file are reported skipped.
      assert.deepEqual(byId.names.mutantCounts, { passed: 0, failed: 1, skipped: 3, ran: 4 });

      assert.equal(exitCode, 1, 'a survivor exits 1');
      assert.deepEqual(trackedBytes(repo.root), before, 'the tree is byte-identical');
      assert.equal(repo.status(), '', 'git status is clean');
      assert.equal(existsSync(path.join(repo.root, '.vitest')), false, 'no Vitest default report dir');
    } finally { repo.cleanup(); }
  });

  test('baseline establishes a baseline-scope canary through the discovered test patterns', async () => {
    const repo = makeVitestRepo({ files: FILES, label: 'vitest-baseline' });
    try {
      const { exitCode, report } = await runJson(repo, ['baseline']);
      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.equal(report.gates.canary.scope, 'baseline');
      assert.equal(report.gates.canary.status, 'KILLED', report.gates.canary.detail);
      assert.match(report.gates.canary.target, /^test\/.*\.test\.js$/);
      assert.equal(exitCode, 0);
      assert.equal(repo.status(), '');
    } finally { repo.cleanup(); }
  });

  // Invariant: relativisation uses the workspace root the command ran in, not
  // the real tree -- in copy mode those differ.
  test('copy mode, with node_modules preserved, grades KILLED', async () => {
    const repo = makeVitestRepo({ files: FILES, config: { isolation: 'copy' }, mutants: [KILLED], label: 'vitest-copy' });
    try {
      const { report } = await runJson(repo, ['run', '--all']);
      assert.notEqual(report.workspaceRoot, repo.root);
      assert.equal(report.results[0].verdict, 'KILLED', report.results[0].detail);
      assert.equal(repo.status(), '');
    } finally { repo.cleanup(); }
  });

  // Invariant: a requested file the runner did not run is never a pass.
  test('a scope file outside Vitest\'s include is ERROR scope-non-green, never SURVIVED', async () => {
    const repo = makeVitestRepo({
      files: {
        'src/guard.mjs': GUARD,
        'test/guard.test.js': GUARD_TESTS,
        'test/other.test.js': "import { test } from 'vitest';\ntest('other', () => {});\n",
        'vitest.config.mjs': "export default { test: { include: ['test/guard.test.js'] } };\n",
      },
      mutants: [{ ...SURVIVED, expectPass: ['test/other.test.js::other'] }],
      label: 'vitest-include',
    });
    try {
      const { report } = await runJson(repo, ['run', '--all']);
      const result = report.results[0];
      assert.equal(result.verdict, 'ERROR', result.detail);
      assert.equal(result.reason, 'scope-non-green');
      assert.match(result.detail, /test\/other\.test\.js is in scope but the runner reported no test from it/);
    } finally { repo.cleanup(); }
  });
});

