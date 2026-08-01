// Fixture builder: a real git repository in a fresh temp directory.
//
// Real git, because the runner's safety properties are defined against it (the
// clean-tree assertion, `git apply`, gitignore checks) and a fake would prove
// nothing. Each repo is self-contained under os.tmpdir() and removed by its own
// cleanup, so tests pass in any order and share no state.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(root, relPath, content) {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

export function read(root, relPath) {
  return readFileSync(path.join(root, relPath), 'utf8');
}

export function readBytes(root, relPath) {
  return readFileSync(path.join(root, relPath));
}

export const DEFAULT_CONFIG = {
  baselineCommand: 'node --test',
  testCommand: 'node --test {tests}',
  runner: 'node-test',
  isolation: 'in-place',
  preserve: [],
  timeoutMs: 60_000,
  jobs: 1,
};

// `files` is a { relPath: contents } map. `config` is merged over DEFAULT_CONFIG
// and written to harness/mutation/config.json. `mutants` is written to the
// gitignored catalog. Everything is committed except the catalog.
export function makeRepo({
  files = {}, config = {}, mutants = null, gitignore = '.mutation/\n', label = 'repo',
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), `code-mutant-test-${label}-`));
  git(root, ['init', '-q', '.']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'code-mutant test']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  if (gitignore !== null) write(root, '.gitignore', gitignore);
  for (const [relPath, contents] of Object.entries(files)) write(root, relPath, contents);

  if (config !== null) {
    write(
      root,
      path.join('harness', 'mutation', 'config.json'),
      `${JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2)}\n`,
    );
  }

  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'fixture']);

  if (mutants) {
    write(root, path.join('.mutation', 'mutants.json'), `${JSON.stringify({ mutants }, null, 2)}\n`);
  }

  return {
    root,
    status() { return git(root, ['status', '--porcelain']); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

// A passing two-test node suite plus the module it exercises. The shape most of
// the integration tests need: one invariant with a sibling test in the same file,
// which is what makes the narrowing policy observable.
export const GUARD_SOURCE = `export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  return kind === 'user-defined';
}
`;

export const GUARD_TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed } from '../src/guard.mjs';

test('allows ollama', () => { assert.equal(isAllowed('ollama'), true); });
test('allows user-defined backends', () => { assert.equal(isAllowed('user-defined'), true); });
test('rejects unknown', () => { assert.equal(isAllowed('nope'), false); });
`;

export function guardFiles() {
  return { 'src/guard.mjs': GUARD_SOURCE, 'test/guard.test.mjs': GUARD_TESTS };
}
