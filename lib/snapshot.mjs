// Byte-snapshot restore: the one place in this runner where a bug destroys a
// human's work.
//
// THE RULE: no git operation is ever used to restore. Not `git checkout --`, not
// `git apply --reverse`. The ban is on the category, not on one command. A
// worker's tree normally carries uncommitted edits to the very file being
// mutated, and both of those commands silently discard them. `git apply` FORWARD
// (to apply a patch site) is fine and lives in apply.mjs; its inverse is not.
//
// ABSENCE IS A STATE. A patch site has no single `file` field and `git apply` can
// create and delete files, so every path is snapshotted as either its pre-bytes
// or the `ABSENT` sentinel. Restore then overwrites modified paths, deletes
// created ones, and recreates deleted ones byte-identical.
//
// Restore is fully synchronous because it runs from a `process.on('exit')`
// handler, which cannot await -- hence contents held in memory as Buffers.

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { registerCleanup, unregisterCleanup } from './cleanup.mjs';

export const ABSENT = Symbol('code-mutant:absent');

export class SnapshotError extends Error {}

// Restore deletes paths recorded as ABSENT, so a malformed relative path is a
// destructive-delete hazard rather than a cosmetic problem. Validated at capture
// time, before anything is written.
export function assertSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new SnapshotError('snapshot path must be a non-empty string');
  }
  if (path.isAbsolute(rel)) {
    throw new SnapshotError(`snapshot path must be relative to the workspace root: ${rel}`);
  }
  const normalized = path.normalize(rel);
  if (normalized === '.' || normalized === '..' || normalized.split(path.sep).includes('..')) {
    throw new SnapshotError(`snapshot path escapes the workspace root: ${rel}`);
  }
  return normalized;
}

// Ancestor directories of `rel` between the root and the file, deepest last.
function ancestorDirs(rel) {
  const parts = path.normalize(rel).split(path.sep).slice(0, -1);
  const dirs = [];
  for (let i = 1; i <= parts.length; i += 1) dirs.push(parts.slice(0, i).join(path.sep));
  return dirs;
}

export function captureSnapshot(root, relPaths) {
  const entries = new Map();
  const absentDirs = new Set();

  for (const raw of relPaths) {
    const rel = assertSafeRelPath(raw);
    if (entries.has(rel)) continue;
    const abs = path.resolve(root, rel);

    let stat = null;
    try { stat = lstatSync(abs); } catch { /* absent is a valid state */ }

    if (stat && stat.isFile()) {
      entries.set(rel, { content: readFileSync(abs), mode: stat.mode });
    } else if (stat) {
      // A symlink or directory where a mutated file should be. Restoring these
      // faithfully is not something any mutant needs, and guessing would risk
      // the very data loss this module exists to prevent.
      throw new SnapshotError(`refusing to snapshot ${rel}: not a regular file`);
    } else {
      entries.set(rel, { content: ABSENT, mode: null });
    }

    // Directories that do not exist yet may be created by the apply; record them
    // so restore can take them back out.
    for (const dir of ancestorDirs(rel)) {
      if (!existsSync(path.resolve(root, dir))) absentDirs.add(dir);
    }
  }

  return {
    root,
    entries,
    // Deepest first, so nested directories come out from the inside.
    absentDirs: [...absentDirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length),
    cleanupId: null,
  };
}

// Synchronous, and collects failures rather than throwing on the first one: a
// partial restore that stops halfway is worse than one that tries every path and
// then reports exactly what it could not put back.
export function restoreSnapshot(snapshot) {
  const failures = [];

  for (const [rel, entry] of snapshot.entries) {
    const abs = path.resolve(snapshot.root, rel);
    try {
      if (entry.content === ABSENT) {
        // The path is meant not to exist. recursive covers an apply that put a
        // directory where a file was; assertSafeRelPath already ruled out the
        // paths that would make this dangerous.
        rmSync(abs, { force: true, recursive: true });
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, entry.content);
        if (entry.mode !== null) chmodSync(abs, entry.mode);
      }
    } catch (err) {
      failures.push({ path: rel, error: err?.message ?? String(err) });
    }
  }

  // rmdirSync only succeeds on an empty directory, which is exactly the wanted
  // behaviour: a directory the apply created is removed, one that picked up
  // unrelated files is left alone.
  for (const dir of snapshot.absentDirs) {
    try { rmdirSync(path.resolve(snapshot.root, dir)); } catch { /* not empty, or never created */ }
  }

  return failures;
}

// Proves the restore rather than assuming it: re-reads every path and compares
// to the captured bytes, treating ABSENT as a state to verify too.
export function verifySnapshot(snapshot) {
  const drift = [];
  for (const [rel, entry] of snapshot.entries) {
    const abs = path.resolve(snapshot.root, rel);
    const exists = existsSync(abs);
    if (entry.content === ABSENT) {
      if (exists) drift.push({ path: rel, reason: 'should be absent but exists' });
      continue;
    }
    if (!exists) {
      drift.push({ path: rel, reason: 'should exist but is absent' });
      continue;
    }
    let actual;
    try { actual = readFileSync(abs); } catch (err) {
      drift.push({ path: rel, reason: `unreadable: ${err.message}` });
      continue;
    }
    if (!actual.equals(entry.content)) {
      drift.push({ path: rel, reason: `bytes differ (${entry.content.length} captured, ${actual.length} now)` });
    }
  }
  return drift;
}

// Tracked snapshots are restored by the exit/signal guard. Track immediately
// after capture and before any mutation is applied, so an interrupt between the
// two is still covered.
export function trackSnapshot(snapshot) {
  snapshot.cleanupId = registerCleanup(() => restoreSnapshot(snapshot), `restore ${snapshot.root}`);
  return snapshot;
}

export function untrackSnapshot(snapshot) {
  if (snapshot.cleanupId !== null) {
    unregisterCleanup(snapshot.cleanupId);
    snapshot.cleanupId = null;
  }
}

// The normal path: restore, stop the guard from doing it again, then prove it.
// Throws on any failure or drift -- a restore that did not fully succeed must
// never be reported quietly.
export function restoreAndVerify(snapshot) {
  const failures = restoreSnapshot(snapshot);
  untrackSnapshot(snapshot);
  const drift = verifySnapshot(snapshot);
  if (failures.length || drift.length) {
    const detail = [
      ...failures.map((f) => `  ${f.path}: restore failed: ${f.error}`),
      ...drift.map((d) => `  ${d.path}: ${d.reason}`),
    ].join('\n');
    throw new SnapshotError(`restore did not return the tree to its pre-mutation bytes:\n${detail}`);
  }
}
