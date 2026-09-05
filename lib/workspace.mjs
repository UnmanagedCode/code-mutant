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

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerCleanup, unregisterCleanup } from './cleanup.mjs';
import { gitCapture } from './git.mjs';
import { createOccupancy } from './occupancy.mjs';

export class WorkspaceError extends Error {}

export function gitStatusPorcelain(root) {
  try {
    return gitCapture(root, ['status', '--porcelain']);
  } catch (err) {
    throw new WorkspaceError(`could not read git status in ${root}: ${err.message}`);
  }
}

export function findRepoRoot(startDir) {
  try {
    return gitCapture(startDir, ['rev-parse', '--show-toplevel']).trim();
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
      occupancy: createOccupancy(repoRoot),
      dispose() { /* nothing to discard; snapshots restore the real tree */ },
      // Proves the reviewer left no trace: not just the mutated targets (which
      // the snapshot already verifies) but the whole tree, so a synthesised
      // canary on a path no catalog entry names cannot leave residue unnoticed.
      // Strictly stronger than the occupancy ledger's residue check, which is
      // bounded to paths code-mutant wrote, so in-place does not consult it.
      assertNoTrace() {
        const statusAfter = gitStatusPorcelain(repoRoot);
        if (statusAfter === statusBefore) {
          return { ok: true, before: statusBefore, after: statusAfter, residue: [] };
        }
        return { ok: false, before: statusBefore, after: statusAfter, residue: [] };
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

  const occupancy = createOccupancy(dest);

  return {
    isolation,
    root: dest,
    repoRoot,
    statusBefore: null,
    occupancy,
    dispose() {
      if (cleanupId !== null) { unregisterCleanup(cleanupId); cleanupId = null; }
      rmSync(dest, { recursive: true, force: true });
    },
    // The real tree is never touched here, so this does not assert anything about
    // it. What it asserts is the copy's own integrity: no mutation code-mutant
    // applied is still sitting in it. That is not cosmetic housekeeping -- residue
    // in a copy is measured BY EVERY LATER MUTANT that runs in it, and a constant
    // `{ok: true}` here (what this returned before cards 2026-0010/2026-0029) is
    // exactly why the field run's contaminated copy reported nothing wrong.
    assertNoTrace() {
      const residue = occupancy.residue();
      return { ok: residue.length === 0, before: null, after: null, residue };
    },
  };
}

// One no-trace answer for a run that may hold several copies: residue can be in
// any of them, so checking only the primary would miss it. `before`/`after` come
// from the primary, which is the only workspace for which they mean anything
// (in-place runs are single-workspace by construction).
export function assertNoTraceAcross(workspaces) {
  const residue = [];
  let primary = null;
  for (const workspace of workspaces) {
    // Called ONCE per workspace: in-place spawns a `git status` subprocess here and
    // copy mode re-reads every ledger path, so the primary's answer is kept rather
    // than asked for twice.
    const own = workspace.assertNoTrace();
    if (primary === null) primary = own;
    for (const entry of own.residue ?? []) residue.push({ workspace: workspace.root, ...entry });
  }
  return {
    // Both terms are load-bearing: `primary.ok` carries in-place's whole-tree git
    // status comparison, `residue.length` carries every copy's ledger -- including
    // the copies that are NOT the primary, which is the half a --jobs run hits
    // first.
    ok: primary.ok && residue.length === 0,
    before: primary.before,
    after: primary.after,
    residue,
  };
}
