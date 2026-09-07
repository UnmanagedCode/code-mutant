// Cross-process exclusion for `in-place` isolation.
//
// `lib/occupancy.mjs` guards occupancy with a closure variable, so it binds
// inside ONE runner process. Two sibling `mutate.mjs` processes against one
// in-place worktree are mutually invisible: each applies a mutation to the shared
// tree and byte-restores it, and while one holds a mutation applied the other
// measures its narrow baseline against that poisoned tree. In the field that
// reads as `scope-non-green` -- an ungraded ERROR that never reports as a
// survivor, so it costs a full re-run and misdirects the operator into rewriting
// a correct mutant.
//
// Governing principle: FAIL CLOSED. Where liveness is uncertain, refuse.
//
// THE HOLD RULE IS "no other non-dead claim is visible", and it needs no
// ordering, no tie-break and no retry. Each process publishes its own claim
// BEFORE it lists the directory, so if A's list misses B's claim then B's
// linkSync completed after A's readdir -- and B's readdir follows B's linkSync,
// which follows A's readdir, which follows A's linkSync, so B's list DOES see A.
// At most one process can have a blind view, and every other one sees a claim and
// defers. At most one holder, unconditionally. (readdir need not be a consistent
// snapshot: a concurrently created entry may be missed, which is exactly the
// blind-view case the argument covers.)
//
// Ranking claims instead -- "hold iff no non-dead claim orders before yours" --
// is UNSOUND, because the two processes do not see the same file set: A's set is
// {A} and elects A, while B's set {A,B} elects B under any order that puts B
// first. That is why `acquiredAt` below is a label for the refusal text and never
// an input to the decision.
//
// A claim's filename is a fresh nonce, so one filename names exactly one
// acquisition for all time and no later acquisition can reuse it. DEAD is
// monotone. Together those make unlinking a claim you have classified DEAD
// unconditionally safe: the name can never be reoccupied, so there is no
// successor to delete. Sweeping is therefore decision-neutral -- a DEAD claim is
// ignored by every reader anyway -- which is why anyone may sweep at any time.
// The converse is the dangerous direction: sweeping a claim classified UNKNOWN
// would delete a live peer's claim whose payload we merely failed to read, and
// admit a second holder. So only DEAD is ever unlinked.

import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { registerCleanup, unregisterCleanup } from './cleanup.mjs';
import { gitCapture } from './git.mjs';
import { WorkspaceError } from './workspace.mjs';

export const INPLACE_LOCKED = 'inplace-locked';
export const CLAIM_DIR_NAME = 'code-mutant-inplace.lock.d';
const CLAIM_VERSION = 1;

export const Liveness = { LIVE: 'LIVE', DEAD: 'DEAD', UNKNOWN: 'UNKNOWN' };

// The git dir, not the worktree and not os.tmpdir():
//   - `--absolute-git-dir` yields `.git/worktrees/<name>` in a linked worktree and
//     `.git` in the main checkout, which is exactly the identity in-place guards.
//     Two worktrees of one repo lock independently, with no path hashing.
//   - `git status --porcelain` never reports anything under `.git`, so the claim
//     directory cannot trip the clean-tree gate or in-place's no-trace assertion.
//     Under `.mutation/` it would dirty the tree for `baseline`, which has no hard
//     stop on an unignored `.mutation/`.
//   - Two sibling shells with different TMPDIR would not see each other's lock.
export function claimDirFor(repoRoot) {
  let gitDir;
  try {
    gitDir = gitCapture(repoRoot, ['rev-parse', '--absolute-git-dir']).trim();
  } catch (err) {
    throw new WorkspaceError(
      `could not resolve the git dir of ${repoRoot} to place the in-place lock: ${err.message}`,
    );
  }
  if (!gitDir) {
    throw new WorkspaceError(`git reported no git dir for ${repoRoot}, so the in-place lock has nowhere to live`);
  }
  return path.join(gitDir, CLAIM_DIR_NAME);
}

// Field 22 of /proc/<pid>/stat (start time in jiffies since boot), read as a
// string and paired with the pid to survive pid reuse. Parsed from the LAST ')'
// and never by splitting the whole line: `comm` is field 2 and can contain both
// spaces and parens, which mis-indexes every field after it.
export function readStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    // fields[0] is field 3 (state), so field 22 is fields[19].
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return /^\d+$/.test(startTime ?? '') ? startTime : null;
  } catch {
    return null; // no /proc, or the pid is already gone
  }
}

// A reboot invalidates both the pid and the jiffy count, and is definitive proof
// the holder is dead.
export function readBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function classifyHolder(claim) {
  if (!claim || !Number.isInteger(claim.pid) || claim.pid <= 0) return Liveness.UNKNOWN;
  // A pid liveness check about a different machine means nothing, so a
  // foreign-host claim is never believed dead and (see sweep) never removed.
  if (claim.host !== os.hostname()) return Liveness.UNKNOWN;

  const bootId = readBootId();
  if (bootId && claim.bootId && claim.bootId !== bootId) return Liveness.DEAD;

  try {
    process.kill(claim.pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return Liveness.DEAD;
    return Liveness.UNKNOWN; // EPERM: the pid exists, under another owner
  }

  const startTime = readStartTime(claim.pid);
  if (!startTime || !claim.startTime) return Liveness.UNKNOWN;
  return startTime === String(claim.startTime) ? Liveness.LIVE : Liveness.DEAD;
}

// linkSync from a temp file, NOT openSync(..., 'wx') then write. Exclusivity is
// not what this buys -- the target name is a fresh nonce, so it never contends --
// it is that THE FILE ALREADY CARRIES ITS FULL PAYLOAD at the instant it becomes
// visible. `wx` plus a write leaves a window where a concurrent readdir-then-read
// sees an empty file, has to classify it UNKNOWN, and blocks for nothing.
function tryCreate(target, payload) {
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, payload);
  try {
    linkSync(tmp, target);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// `.json` only: tryCreate's temp file lives in this directory too (linkSync needs
// one filesystem), under a name that is deliberately outside the `<nonce>.json`
// namespace.
function listClaimFiles(claimDir) {
  try {
    return readdirSync(claimDir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// null means "gone" -- swept under us, which means it was already ignorable.
// `{ data: null }` means "present but unclassifiable", which blocks.
function readClaim(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { path: file, data: null };
  }
  try {
    const data = JSON.parse(text);
    return { path: file, data: data && typeof data === 'object' ? data : null };
  } catch {
    return { path: file, data: null };
  }
}

// The claim named in the refusal text: the earliest `acquiredAt` among the
// blockers we could actually read. A LABEL FOR THE READER ONLY -- it never
// participates in the hold decision, which is "no other non-dead claim is
// visible" and needs no order at all.
function describeHolder(blockers) {
  const readable = blockers
    .map((b) => b.data)
    .filter((d) => d && Number.isInteger(d.pid))
    .sort((a, b) => String(a.acquiredAt ?? '').localeCompare(String(b.acquiredAt ?? '')));
  const holder = readable[0];
  if (!holder) return null;
  return {
    pid: holder.pid,
    startTime: holder.startTime ?? null,
    host: holder.host ?? null,
    command: holder.command ?? null,
    acquiredAt: holder.acquiredAt ?? null,
    tree: holder.tree ?? null,
  };
}

const WHY = 'Two processes in one tree interleave their snapshot and restore, so this run would '
  + "measure its baseline against the other's mutation and no verdict from either would be "
  + 'interpretable.';

function refusalDetail({ holder, claimDir, blockedBy }) {
  const also = blockedBy > 1
    ? ` ${blockedBy} claims blocked; the earliest is named here.`
    : '';
  if (!holder) {
    return `${blockedBy} claim(s) in ${claimDir} could not be shown to belong to a dead process, so `
      + `this worktree may be held by another code-mutant process. ${WHY} Nothing was mutated. `
      + 'Once you have confirmed no code-mutant process is running against this tree, remove the '
      + 'claim(s) by hand, or use `--copy`.';
  }
  return `another code-mutant process is mutating this worktree in-place: pid ${holder.pid} `
    + `(\`${holder.command ?? 'unknown command'}\`, since ${holder.acquiredAt ?? 'an unrecorded time'}) `
    + `claims ${holder.tree ?? 'this tree'} via ${claimDir}. ${WHY} Nothing was mutated. Wait for pid `
    + `${holder.pid} to finish, or use \`--copy\`.${also}`;
}

// Synchronous and idempotent, per the cleanup registry's contract: it can run
// from the signal path and then again from the exit path. No ownership check is
// needed -- the filename IS our nonce, so we can only ever delete our own claim.
// A failure is collected rather than thrown: `runCleanupsSync` gathers arrays and
// `guard.mjs` prints them under RESTORE INCOMPLETE.
function releaseSync(claimPath) {
  try {
    rmSync(claimPath, { force: true });
    return [];
  } catch (err) {
    return [{ label: 'release in-place lock', path: claimPath, error: err?.message ?? String(err) }];
  }
}

export function acquireInPlaceLock({ repoRoot, command = null, log = () => {} }) {
  const claimDir = claimDirFor(repoRoot);
  // Idempotent, needs no exclusivity, and is never removed: an empty claim
  // directory is a valid resting state, so creating it has no crash window.
  try {
    mkdirSync(claimDir, { recursive: true });
  } catch (err) {
    throw new WorkspaceError(`could not create the in-place lock directory ${claimDir}: ${err.message}`);
  }

  const nonce = randomUUID();
  const claimPath = path.join(claimDir, `${nonce}.json`);
  const self = {
    version: CLAIM_VERSION,
    pid: process.pid,
    startTime: readStartTime(process.pid),
    bootId: readBootId(),
    host: os.hostname(),
    nonce,
    tree: repoRoot,
    command,
    acquiredAt: new Date().toISOString(),
  };
  // PUBLISHED BEFORE THE LIST, which is the whole of the mutual-exclusion
  // argument in this file's header. A fresh nonce never contends.
  if (!tryCreate(claimPath, `${JSON.stringify(self)}\n`)) {
    throw new WorkspaceError(
      `the in-place lock claim ${claimPath} already exists, so a UUID collided or something else is `
      + 'writing this directory -- refusing rather than sharing a claim name',
    );
  }

  const blockers = [];
  for (const name of listClaimFiles(claimDir)) {
    if (name === `${nonce}.json`) continue;
    const claim = readClaim(path.join(claimDir, name));
    if (!claim) continue;
    // Only DEAD is unlinked, and DEAD is already ignored by every reader, so a
    // sweep can never change another process's verdict. Two processes sweeping
    // the same claim is harmless: the second rmSync is a no-op under `force`.
    if (classifyHolder(claim.data) === Liveness.DEAD) {
      rmSync(claim.path, { force: true });
      continue;
    }
    blockers.push(claim); // LIVE or UNKNOWN
  }

  if (blockers.length) {
    // A deferring process withdraws its own claim. Left behind it is a live claim
    // that would block the next invocation; killed before this, it becomes a dead
    // claim the next run ignores and sweeps. No wedge either way.
    releaseSync(claimPath);
    const holder = describeHolder(blockers);
    return {
      held: false,
      code: INPLACE_LOCKED,
      claimDir,
      claimPath: null,
      nonce,
      holder,
      blockedBy: blockers.length,
      detail: refusalDetail({ holder, claimDir, blockedBy: blockers.length }),
    };
  }

  // Registered BEFORE any snapshot, and `runCleanupsSync` runs in reverse
  // registration order, so the lock releases LAST -- after the tree is restored.
  // Another process is never admitted to a still-mutated tree.
  const cleanupId = registerCleanup(() => releaseSync(claimPath), 'release in-place lock');
  let released = false;

  return {
    held: true,
    code: null,
    claimDir,
    claimPath,
    nonce,
    holder: null,
    blockedBy: 0,
    detail: `no other code-mutant process holds this worktree in-place (claim ${claimPath})`,
    // Never fails the run: verdicts already measured are valid, and a leaked
    // claim is a future-run problem that self-heals -- once this process exits
    // its claim is dead, so the next run ignores and sweeps it.
    release() {
      if (released) return [];
      released = true;
      unregisterCleanup(cleanupId);
      const failures = releaseSync(claimPath);
      for (const failure of failures) {
        log(`could not release the in-place lock claim ${failure.path}: ${failure.error}`);
      }
      return failures;
    },
  };
}
