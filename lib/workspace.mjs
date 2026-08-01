// The two isolation modes, and the no-trace proof for the risky one.
//
// The restore contract is mode-dependent, and that difference is the whole point
// of having two modes:
//
//   copy      -- restore is DISCARDING THE COPY. The copy is taken from the
//                working tree, so uncommitted changes come with it; a scratch
//                clone from HEAD would silently test the wrong code.
//   in-place  -- restore is byte-snapshot replay (snapshot.mjs), followed by a
//                clean-tree assertion, because the reviewer has to be able to
//                prove it left nothing behind in a worktree it does not own.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerCleanup, unregisterCleanup } from './cleanup.mjs';

export class WorkspaceError extends Error {}

export function gitStatusPorcelain(root) {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new WorkspaceError(`could not read git status in ${root}: ${err.message}`);
  }
}

export function findRepoRoot(startDir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new WorkspaceError(
      `${startDir} is not inside a git repository -- code-mutant needs one to resolve the harness and diff hunks`,
    );
  }
}

function copyTree(repoRoot, dest, preserve) {
  const excluded = new Set(['.git', '.mutation', ...preserve.map((p) => path.normalize(p))]);

  cpSync(repoRoot, dest, {
    recursive: true,
    dereference: false,
    force: true,
    filter: (src) => {
      const rel = path.relative(repoRoot, src);
      if (rel === '') return true;
      const top = rel.split(path.sep)[0];
      if (excluded.has(top) || excluded.has(path.normalize(rel))) return false;
      return true;
    },
  });

  // `preserve` entries are symlinked rather than duplicated -- node_modules and
  // build caches are the reason copy mode would otherwise be unusable.
  for (const entry of preserve) {
    const target = path.resolve(repoRoot, entry);
    const link = path.resolve(dest, entry);
    try {
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new WorkspaceError(`could not preserve ${entry} in the copy: ${err.message}`);
      }
    }
  }
}

export function openWorkspace({ repoRoot, isolation, preserve = [], label = 'run' }) {
  if (isolation === 'in-place') {
    const statusBefore = gitStatusPorcelain(repoRoot);
    return {
      isolation,
      root: repoRoot,
      repoRoot,
      statusBefore,
      dispose() { /* nothing to discard; snapshots restore the real tree */ },
      // Proves the reviewer left no trace: not just the mutated targets (which
      // the snapshot already verifies) but the whole tree, so a synthesised
      // canary on a path no catalog entry names cannot leave residue unnoticed.
      assertNoTrace() {
        const statusAfter = gitStatusPorcelain(repoRoot);
        if (statusAfter === statusBefore) return { ok: true, before: statusBefore, after: statusAfter };
        return { ok: false, before: statusBefore, after: statusAfter };
      },
    };
  }

  if (isolation !== 'copy') {
    throw new WorkspaceError(`unknown isolation mode ${JSON.stringify(isolation)} (expected "in-place" or "copy")`);
  }

  const dest = mkdtempSync(path.join(os.tmpdir(), `code-mutant-${label}-`));
  let cleanupId = null;
  try {
    copyTree(repoRoot, dest, preserve);
    cleanupId = registerCleanup(() => { rmSync(dest, { recursive: true, force: true }); }, `discard ${dest}`);
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }

  return {
    isolation,
    root: dest,
    repoRoot,
    statusBefore: null,
    dispose() {
      if (cleanupId !== null) { unregisterCleanup(cleanupId); cleanupId = null; }
      rmSync(dest, { recursive: true, force: true });
    },
    // In copy mode the real tree is never touched, so there is nothing to prove
    // about it beyond the copy having been discarded.
    assertNoTrace() { return { ok: true, before: null, after: null }; },
  };
}
