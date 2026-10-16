// A real temp git repo driven by this repo's own pinned Vitest (the
// devDependency in package.json), for the end-to-end tests that prove the
// vitest adapter through a full mutate cycle.
//
// Missing Vitest is a FAILURE, never a skip: a skipped proof reads exactly like a
// passing one in a summary line.

import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_FLAGS } from '../../lib/adapters/vitest.mjs';
import { makeRepo } from './tmp-repo.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NODE_MODULES = path.join(REPO, 'node_modules');
export const VITEST_ENTRY = path.join(NODE_MODULES, 'vitest', 'vitest.mjs');

// Run from the repo root through the symlinked node_modules, with the JSON
// report written into the runner's report dir -- the command shape the adapter
// requires (REQUIRED_FLAGS in lib/adapters/vitest.mjs). `--no-cache` because
// every fixture repo shares this repo's node_modules, and Vitest's results cache
// and transform cache would otherwise be files all of them write concurrently.
export const VITEST_RUN = `node node_modules/vitest/vitest.mjs run --no-cache --no-fsModuleCache ${REQUIRED_FLAGS}`;

export function requireVitest() {
  if (!existsSync(VITEST_ENTRY)) throw new Error(`vitest devDependency not installed -- run npm ci (${VITEST_ENTRY})`);
}

// `node_modules` is a symlink to this repo's own, created AFTER the fixture
// commit and gitignored without a trailing slash (git sees a symlink, not a
// directory), so the tree is clean. `preserve` carries it into a copy.
export function linkNodeModules(root) {
  symlinkSync(NODE_MODULES, path.join(root, 'node_modules'));
}

export function makeVitestRepo({
  files = {}, config = {}, mutants = null, label = 'vitest',
} = {}) {
  requireVitest();
  const repo = makeRepo({
    files,
    config: {
      runner: 'vitest',
      baselineCommand: VITEST_RUN,
      testCommand: `${VITEST_RUN} {tests}`,
      preserve: ['node_modules'],
      ...config,
    },
    mutants,
    gitignore: '.mutation/\nnode_modules\n',
    label,
  });
  linkNodeModules(repo.root);
  return repo;
}

// 2000 passing tests with long titles, so every real run's report is far
// larger than a pipe buffer.
export function bulkTests(count = 2000) {
  return `import { test, expect } from 'vitest';

const pad = 'y'.repeat(110);
for (let i = 0; i < ${count}; i += 1) {
  test(\`bulk \${String(i).padStart(4, '0')} \${pad}\`, () => { expect(i >= 0).toBe(true); });
}
`;
}
