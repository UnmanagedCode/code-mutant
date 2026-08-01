// THE UNCOMMITTED-WORK TEST.
//
// This is the regression `git checkout --` would cause, and the reason restore
// never uses a git operation: a worker's tree normally carries uncommitted edits
// to the very file being mutated, and both `git checkout --` and
// `git apply --reverse` silently discard them.
//
// Full flow, in-place, against a repo with a dirty tracked file: the file must
// come back byte-identical WITH the uncommitted edit intact, and
// `git status --porcelain` must be byte-identical too.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { Verdict } from '../lib/classify.mjs';
import { guardFiles, makeRepo, readBytes } from './helpers/tmp-repo.mjs';

const UNCOMMITTED = '\n// UNCOMMITTED WORK BY THE IMPLEMENTER -- must survive the run\n';

const MUTANT = {
  id: 'm1',
  invariant: 'the generalized user-defined-backend branch is load-bearing, not decorative',
  sites: [{
    file: 'src/guard.mjs',
    anchor: "return kind === 'user-defined';",
    replacement: 'return false;',
  }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
  expectPass: ['test/guard.test.mjs::allows ollama'],
  whyNotEquivalent: 'returning false denies a backend the guard is specified to admit',
  narrowTo: 'file',
};

async function runInPlace(repo, mutants) {
  const config = loadConfig({ repoRoot: repo.root, overrides: { isolation: 'in-place' } });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  return execute({ config, adapter, mutants });
}

describe('in-place restore with uncommitted work present', () => {
  test('the dirty file returns byte-identical, uncommitted edit intact', async () => {
    const repo = makeRepo({ files: guardFiles(), label: 'dirty' });
    try {
      // Dirty a tracked file the mutant will edit.
      appendFileSync(`${repo.root}/src/guard.mjs`, UNCOMMITTED);
      const bytesBefore = readBytes(repo.root, 'src/guard.mjs');
      const statusBefore = repo.status();
      assert.match(statusBefore, /src\/guard\.mjs/, 'fixture should be dirty before the run');

      const report = await runInPlace(repo, [MUTANT]);

      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.equal(report.gates.canary.status, 'KILLED', report.gates.canary.detail);
      assert.equal(report.results[0].verdict, Verdict.KILLED, report.results[0].detail);

      const bytesAfter = readBytes(repo.root, 'src/guard.mjs');
      assert.ok(bytesAfter.equals(bytesBefore), 'the mutated file must return byte-identical');
      assert.ok(
        bytesAfter.toString('utf8').includes('UNCOMMITTED WORK BY THE IMPLEMENTER'),
        'the uncommitted edit must still be there -- this is what git checkout -- would have destroyed',
      );
      assert.equal(repo.status(), statusBefore, 'git status --porcelain must be unchanged');
      assert.equal(report.noTrace.ok, true);
    } finally { repo.cleanup(); }
  });

  test('a stale anchor is ERROR and leaves the tree untouched', async () => {
    const repo = makeRepo({ files: guardFiles(), label: 'stale' });
    try {
      appendFileSync(`${repo.root}/src/guard.mjs`, UNCOMMITTED);
      const bytesBefore = readBytes(repo.root, 'src/guard.mjs');
      const statusBefore = repo.status();

      const report = await runInPlace(repo, [{
        ...MUTANT,
        id: 'stale',
        sites: [{ file: 'src/guard.mjs', anchor: 'this text is not in the file', replacement: 'x' }],
      }]);

      assert.equal(report.results[0].verdict, Verdict.ERROR);
      assert.equal(report.results[0].reason, 'anchor-missing');
      assert.ok(readBytes(repo.root, 'src/guard.mjs').equals(bytesBefore));
      assert.equal(repo.status(), statusBefore);
    } finally { repo.cleanup(); }
  });

  test('a multi-site mutant restores every path it touched', async () => {
    const files = {
      ...guardFiles(),
      'src/second.mjs': 'export const LIMIT = 10;\n',
    };
    const repo = makeRepo({ files, label: 'multi' });
    try {
      appendFileSync(`${repo.root}/src/second.mjs`, '// dirty too\n');
      const guardBefore = readBytes(repo.root, 'src/guard.mjs');
      const secondBefore = readBytes(repo.root, 'src/second.mjs');
      const statusBefore = repo.status();

      const report = await runInPlace(repo, [{
        ...MUTANT,
        id: 'double',
        sites: [
          ...MUTANT.sites,
          { file: 'src/second.mjs', anchor: 'LIMIT = 10', replacement: 'LIMIT = 0' },
        ],
      }]);

      assert.equal(report.results[0].verdict, Verdict.KILLED, report.results[0].detail);
      assert.ok(readBytes(repo.root, 'src/guard.mjs').equals(guardBefore));
      assert.ok(readBytes(repo.root, 'src/second.mjs').equals(secondBefore));
      assert.equal(repo.status(), statusBefore);
    } finally { repo.cleanup(); }
  });
});

describe('copy mode', () => {
  test('the real tree is never touched, and the copy carries uncommitted changes', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, label: 'copy' });
    try {
      // The mutation's anchor only exists in the UNCOMMITTED version of the file,
      // so it can only resolve if the copy included uncommitted work. A scratch
      // clone from HEAD would fail here with anchor-missing -- which is exactly
      // the "silently testing the wrong code" failure.
      appendFileSync(
        `${repo.root}/src/guard.mjs`,
        '\nexport function onlyUncommitted() { return 42; }\n',
      );
      const bytesBefore = readBytes(repo.root, 'src/guard.mjs');

      const config = loadConfig({ repoRoot: repo.root });
      const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
      const report = await execute({
        config,
        adapter,
        mutants: [{
          ...MUTANT,
          id: 'uncommitted-anchor',
          sites: [{ file: 'src/guard.mjs', anchor: 'return 42;', replacement: 'return 0;' }],
          expectFail: [],
          expectPass: ['test/guard.test.mjs::allows ollama'],
        }],
      });

      assert.equal(config.isolation, 'copy');
      assert.notEqual(report.workspaceRoot, repo.root, 'copy mode must not run in the real tree');
      assert.notEqual(
        report.results[0].reason,
        'anchor-missing',
        'the copy must include uncommitted changes, not be a clone from HEAD',
      );
      assert.ok(readBytes(repo.root, 'src/guard.mjs').equals(bytesBefore));
      assert.equal(report.noTrace.ok, true);
    } finally { repo.cleanup(); }
  });
});
