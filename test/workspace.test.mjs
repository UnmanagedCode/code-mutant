// Isolation modes and config validation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { NoHarnessError, loadConfig } from '../lib/config.mjs';
import { WorkspaceError, findRepoRoot, openWorkspace } from '../lib/workspace.mjs';
import { guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';

describe('copy isolation', () => {
  test('the copy carries uncommitted changes and excludes .git and .mutation', () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [], label: 'copy-contents' });
    try {
      writeFileSync(path.join(repo.root, 'src/guard.mjs'), 'export const UNCOMMITTED = true;\n');
      const workspace = openWorkspace({ repoRoot: repo.root, isolation: 'copy', preserve: [] });
      try {
        assert.notEqual(workspace.root, repo.root);
        assert.equal(
          readFileSync(path.join(workspace.root, 'src/guard.mjs'), 'utf8'),
          'export const UNCOMMITTED = true;\n',
          'the copy must be of the WORKING TREE, not of HEAD',
        );
        // .git would make the copy a repo whose index disagrees with its files;
        // .mutation is the reviewer's own state and belongs to the real tree only.
        assert.equal(existsSync(path.join(workspace.root, '.git')), false);
        assert.equal(existsSync(path.join(workspace.root, '.mutation')), false);
        assert.equal(existsSync(path.join(workspace.root, 'harness/mutation/config.json')), true);
      } finally { workspace.dispose(); }
      assert.equal(existsSync(path.join(repo.root, 'src/guard.mjs')), true);
    } finally { repo.cleanup(); }
  });

  test('preserve paths are symlinked, not duplicated', () => {
    const repo = makeRepo({ files: guardFiles(), label: 'preserve' });
    try {
      mkdirSync(path.join(repo.root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(path.join(repo.root, 'node_modules/dep/index.js'), 'module.exports = 1;\n');

      const workspace = openWorkspace({
        repoRoot: repo.root, isolation: 'copy', preserve: ['node_modules'],
      });
      try {
        const link = path.join(workspace.root, 'node_modules');
        assert.ok(lstatSync(link).isSymbolicLink(), 'node_modules should be a symlink');
        assert.equal(
          readFileSync(path.join(link, 'dep/index.js'), 'utf8'),
          'module.exports = 1;\n',
          'and it should resolve to the real one',
        );
      } finally { workspace.dispose(); }
    } finally { repo.cleanup(); }
  });

  test('disposing removes the copy', () => {
    const repo = makeRepo({ files: guardFiles(), label: 'dispose' });
    try {
      const workspace = openWorkspace({ repoRoot: repo.root, isolation: 'copy', preserve: [] });
      const copyRoot = workspace.root;
      assert.equal(existsSync(copyRoot), true);
      workspace.dispose();
      assert.equal(existsSync(copyRoot), false);
    } finally { repo.cleanup(); }
  });
});

describe('in-place isolation', () => {
  test('runs in the real tree and captures status for the no-trace assertion', () => {
    const repo = makeRepo({ files: guardFiles(), label: 'inplace-ws' });
    try {
      const workspace = openWorkspace({ repoRoot: repo.root, isolation: 'in-place', preserve: [] });
      assert.equal(workspace.root, repo.root);
      assert.equal(workspace.assertNoTrace().ok, true);

      writeFileSync(path.join(repo.root, 'leftover.txt'), 'residue');
      const after = workspace.assertNoTrace();
      assert.equal(after.ok, false, 'a new untracked file must fail the no-trace assertion');
      assert.match(after.after, /leftover\.txt/);
    } finally { repo.cleanup(); }
  });

  test('an unknown isolation mode is refused', () => {
    const repo = makeRepo({ files: guardFiles(), label: 'bad-iso' });
    try {
      assert.throws(
        () => openWorkspace({ repoRoot: repo.root, isolation: 'sideways', preserve: [] }),
        WorkspaceError,
      );
    } finally { repo.cleanup(); }
  });
});

describe('config', () => {
  test('CLI flags override config isolation', () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'in-place' }, label: 'override' });
    try {
      assert.equal(loadConfig({ repoRoot: repo.root }).isolation, 'in-place');
      assert.equal(
        loadConfig({ repoRoot: repo.root, overrides: { isolation: 'copy' } }).isolation,
        'copy',
      );
    } finally { repo.cleanup(); }
  });

  test('jobs is clamped to 1 in-place, as a LOGGED degradation', () => {
    const repo = makeRepo({
      files: guardFiles(), config: { isolation: 'in-place', jobs: 4 }, label: 'jobs',
    });
    try {
      const warnings = [];
      const config = loadConfig({ repoRoot: repo.root, warn: (m) => warnings.push(m) });
      assert.equal(config.jobs, 1, 'concurrent mutation of one tree is unsafe');
      assert.equal(warnings.length, 1, 'the degradation must not be silent');
      assert.match(warnings[0], /not available in in-place mode/);
    } finally { repo.cleanup(); }
  });

  test('jobs is honoured in copy mode, with the concurrent-suite caveat named', () => {
    const repo = makeRepo({
      files: guardFiles(), config: { isolation: 'copy', jobs: 3 }, label: 'jobs-copy',
    });
    try {
      const warnings = [];
      assert.equal(loadConfig({ repoRoot: repo.root, warn: (m) => warnings.push(m) }).jobs, 3);
      // Not clamped -- copy mode really is safe for the RUNNER (one copy per
      // worker, asserted). The advisory is about the project's own suite, so it
      // has to name what makes a suite unsafe or the reader cannot check theirs
      // against it.
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /3 times CONCURRENTLY/);
      for (const hazard of [/fixed TCP port/, /fixed temp or data directory/, /shares a database/, /build\/package\s*cache/, /absolute path/, /SYMLINKED/]) {
        assert.match(warnings[0], hazard, `the advisory must name ${hazard}`);
      }
    } finally { repo.cleanup(); }
  });

  test('jobs=1 in copy mode says nothing -- the caveat is about concurrency only', () => {
    const repo = makeRepo({
      files: guardFiles(), config: { isolation: 'copy', jobs: 1 }, label: 'jobs-copy-one',
    });
    try {
      const warnings = [];
      assert.equal(loadConfig({ repoRoot: repo.root, warn: (m) => warnings.push(m) }).jobs, 1);
      assert.deepEqual(warnings, []);
    } finally { repo.cleanup(); }
  });

  test('a missing harness is a supported state, not a refusal', () => {
    const repo = makeRepo({ files: guardFiles(), config: null, label: 'no-harness' });
    try {
      assert.throws(
        () => loadConfig({ repoRoot: repo.root }),
        // The negations are asserted PRESENT, not the words absent: this message's
        // job is to negate the gap/escalate framing, so word-absence would pin the
        // opposite of what it reads like. Anti-accumulation guard -- a later
        // "emphasize the gap" edit has to delete "not a gap" to land, and fails here.
        (err) => err instanceof NoHarnessError
          && /not configured for mutation testing/.test(err.message)
          && /scaffold\/harness\.md/.test(err.message)
          && /not a gap/.test(err.message)
          && /nothing to escalate/.test(err.message)
          && !/Report the gap upward/.test(err.message),
      );
    } finally { repo.cleanup(); }
  });

  test('required fields and enum values are validated', () => {
    const cases = [
      [{ baselineCommand: '' }, /"baselineCommand" must be a non-empty string/],
      [{ testCommand: undefined }, /"testCommand" must be a non-empty string/],
      [{ isolation: 'nope' }, /"isolation" must be "in-place" or "copy"/],
      [{ preserve: 'node_modules' }, /"preserve" must be an array/],
      [{ timeoutMs: 0 }, /"timeoutMs" must be a positive number/],
      [{ jobs: 0 }, /"jobs" must be a positive integer/],
    ];
    for (const [override, pattern] of cases) {
      const repo = makeRepo({ files: guardFiles(), label: 'invalid' });
      try {
        const configPath = path.join(repo.root, 'harness/mutation/config.json');
        const raw = JSON.parse(readFileSync(configPath, 'utf8'));
        writeFileSync(configPath, JSON.stringify({ ...raw, ...override }));
        assert.throws(() => loadConfig({ repoRoot: repo.root }), pattern);
      } finally { repo.cleanup(); }
    }
  });

  test('malformed JSON is reported with the file name', () => {
    const repo = makeRepo({ files: guardFiles(), label: 'bad-json' });
    try {
      write(repo.root, 'harness/mutation/config.json', '{ not json');
      assert.throws(() => loadConfig({ repoRoot: repo.root }), /not valid JSON/);
    } finally { repo.cleanup(); }
  });
});

describe('repo discovery', () => {
  test('findRepoRoot finds the worktree root from a subdirectory', () => {
    const repo = makeRepo({ files: guardFiles(), label: 'discover' });
    try {
      assert.equal(
        readFileSync(path.join(findRepoRoot(path.join(repo.root, 'src')), '.gitignore'), 'utf8'),
        '.mutation/\n',
      );
    } finally { repo.cleanup(); }
  });
});
