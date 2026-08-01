// PATCH-SITE RESTORE: the case the anchor-only restore contract silently missed.
//
// A patch site has no single `file` field, and `git apply` can create and delete
// files. So absence has to be a snapshotable state in both directions: a patch
// that creates a file must have it deleted on restore, and one that deletes a file
// must have it recreated byte-identical.
//
// Each test proves the mutation was LIVE DURING THE RUN via the observer command,
// because "the created file is absent afterwards" would also be true if the patch
// had never been applied at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { guardFiles, makeRepo, readBytes } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OBSERVER = path.join(HERE, 'helpers', 'observe-command.mjs');

const REMOVABLE = 'export const REMOVABLE = true;\n';

const CREATE_PATCH = `diff --git a/src/extra.mjs b/src/extra.mjs
new file mode 100644
--- /dev/null
+++ b/src/extra.mjs
@@ -0,0 +1 @@
+export const EXTRA = 1;
`;

const DELETE_PATCH = `diff --git a/src/removable.mjs b/src/removable.mjs
deleted file mode 100644
--- a/src/removable.mjs
+++ /dev/null
@@ -1 +0,0 @@
-export const REMOVABLE = true;
`;

async function runWithObserver({ repo, mutant, observePaths }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-observe-'));
  const outFile = path.join(scratch, 'observed.json');
  try {
    const config = loadConfig({ repoRoot: repo.root, overrides: { isolation: 'in-place' } });
    const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
    process.env.CM_OBSERVE_PATHS = observePaths.join(',');
    process.env.CM_OBSERVE_OUT = outFile;
    const report = await execute({ config, adapter, mutants: [mutant] });
    const observed = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
    return { report, observed };
  } finally {
    delete process.env.CM_OBSERVE_PATHS;
    delete process.env.CM_OBSERVE_OUT;
    rmSync(scratch, { recursive: true, force: true });
  }
}

function observerConfig() {
  return {
    // Baseline stays the real suite so the gates are genuine; only the per-mutant
    // command is faked, because what is under test here is restore, not parsing.
    baselineCommand: 'node --test',
    testCommand: `node ${JSON.stringify(OBSERVER)} {tests}`,
    runner: 'node-test',
    isolation: 'in-place',
  };
}

const BASE_MUTANT = {
  invariant: 'a structural change an anchor cannot express',
  expectFail: [],
  expectPass: ['test/guard.test.mjs::allows ollama'],
  whyNotEquivalent: 'the file set itself changes, which is behaviour for a loader that enumerates it',
  narrowTo: 'file',
};

describe('patch sites restore in-place', () => {
  test('a patch that CREATES a file: present during the run, absent afterwards', async () => {
    const repo = makeRepo({ files: guardFiles(), config: observerConfig(), label: 'patch-create' });
    try {
      const statusBefore = repo.status();
      assert.equal(existsSync(path.join(repo.root, 'src/extra.mjs')), false);

      const { report, observed } = await runWithObserver({
        repo,
        mutant: { ...BASE_MUTANT, id: 'patch-create', sites: [{ patch: CREATE_PATCH }] },
        observePaths: ['src/extra.mjs'],
      });

      assert.notEqual(report.results[0].verdict, 'ERROR', report.results[0].detail);
      assert.ok(observed, 'the observer command should have run');
      assert.equal(
        observed.observed['src/extra.mjs'].exists,
        true,
        'the patch must actually have been applied during the run',
      );

      assert.equal(
        existsSync(path.join(repo.root, 'src/extra.mjs')),
        false,
        'a file the patch created must be deleted on restore -- absence is a state',
      );
      assert.equal(repo.status(), statusBefore, 'no new untracked file may be left behind');
      assert.equal(report.noTrace.ok, true);
    } finally { repo.cleanup(); }
  });

  test('a patch that DELETES a file: gone during the run, back byte-identical afterwards', async () => {
    const repo = makeRepo({
      files: { ...guardFiles(), 'src/removable.mjs': REMOVABLE },
      config: observerConfig(),
      label: 'patch-delete',
    });
    try {
      const bytesBefore = readBytes(repo.root, 'src/removable.mjs');
      const statusBefore = repo.status();

      const { report, observed } = await runWithObserver({
        repo,
        mutant: { ...BASE_MUTANT, id: 'patch-delete', sites: [{ patch: DELETE_PATCH }] },
        observePaths: ['src/removable.mjs'],
      });

      assert.notEqual(report.results[0].verdict, 'ERROR', report.results[0].detail);
      assert.ok(observed, 'the observer command should have run');
      assert.equal(
        observed.observed['src/removable.mjs'].exists,
        false,
        'the patch must actually have deleted the file during the run',
      );

      assert.equal(existsSync(path.join(repo.root, 'src/removable.mjs')), true, 'the deleted file must come back');
      assert.ok(
        readBytes(repo.root, 'src/removable.mjs').equals(bytesBefore),
        'and it must come back byte-identical',
      );
      assert.equal(repo.status(), statusBefore);
      assert.equal(report.noTrace.ok, true);
    } finally { repo.cleanup(); }
  });

  test('a patch mutant restores a file it created inside a new directory', async () => {
    const patch = `diff --git a/src/deep/nested/new.mjs b/src/deep/nested/new.mjs
new file mode 100644
--- /dev/null
+++ b/src/deep/nested/new.mjs
@@ -0,0 +1 @@
+export const NESTED = 1;
`;
    const repo = makeRepo({ files: guardFiles(), config: observerConfig(), label: 'patch-deep' });
    try {
      const statusBefore = repo.status();
      const { observed } = await runWithObserver({
        repo,
        mutant: { ...BASE_MUTANT, id: 'patch-deep', sites: [{ patch }] },
        observePaths: ['src/deep/nested/new.mjs'],
      });
      assert.equal(observed.observed['src/deep/nested/new.mjs'].exists, true);
      assert.equal(existsSync(path.join(repo.root, 'src/deep')), false, 'created directories are removed too');
      assert.equal(repo.status(), statusBefore);
    } finally { repo.cleanup(); }
  });
});
