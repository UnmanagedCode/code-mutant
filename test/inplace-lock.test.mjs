// A SECOND IN-PLACE INVOCATION AGAINST A LIVE-HELD WORKTREE MUST REFUSE.
//
// Card 2026-0049. `lib/occupancy.mjs` guards occupancy with a closure variable, so
// N sibling `mutate.mjs` processes against one in-place worktree are mutually
// invisible: while one holds a mutation applied, another measures its narrow
// baseline against that poisoned tree. `lib/inplace-lock.mjs` publishes a claim
// under `<git-dir>/code-mutant-inplace.lock.d/` and refuses when another
// non-dead claim is visible.
//
// THE OBVIOUS TEST PASSES VACUOUSLY. "Plant a claim, assert acquire refuses" is
// satisfied by an implementation that refuses whenever the claim directory is
// non-empty -- which wedges the worktree permanently the first time a holder is
// SIGKILLed, and needs a human with `rm` to un-wedge it. So liveness is pinned in
// both directions (T3/T4/T5), and so is the sweep in both directions (T9/T9b/T9c):
// over-sweeping is the failure that admits a second holder, because it deletes a
// live peer's claim whose payload it merely failed to read.
//
// No sleeps anywhere: `waitFor` and marker files only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireInPlaceLock, claimDirFor, readBootId, readStartTime,
} from '../lib/inplace-lock.mjs';
import { RUNNER, childEnv, runCli } from './helpers/cli.mjs';
import { git, guardFiles, makeRepo } from './helpers/tmp-repo.mjs';
import { waitFor } from './helpers/wait.mjs';

// Reads /proc/self/stat field 22 from the LAST ')' -- `comm` can contain spaces
// and parens, so splitting the whole line on whitespace mis-indexes it. The same
// parse the module under test has to do, written independently here so a test
// bug and a product bug cannot cancel out.
const PRINT_START_TIME = `
const s = require('node:fs').readFileSync('/proc/self/stat', 'utf8');
process.stdout.write(s.slice(s.lastIndexOf(')') + 1).trim().split(/\\s+/)[19]);
`;

// A pid that is genuinely gone, paired with the start time it genuinely had --
// never a fabricated number, which would let the (pid, startTime) comparison pass
// for the wrong reason.
async function reapedProcess() {
  const child = spawn(process.execPath, ['-e', PRINT_START_TIME], { stdio: ['ignore', 'pipe', 'pipe'] });
  const { pid } = child;
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', () => {});
  await new Promise((resolve) => { child.on('close', resolve); });
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { what: 'the probe process to be reaped' });
  const startTime = out.trim();
  assert.match(startTime, /^\d+$/, 'the probe must report a real /proc start time');
  return { pid, startTime };
}

function plantClaim(claimDir, overrides = {}) {
  mkdirSync(claimDir, { recursive: true });
  const nonce = overrides.nonce ?? randomUUID();
  const claim = {
    version: 1,
    pid: process.pid,
    startTime: readStartTime(process.pid),
    bootId: readBootId(),
    host: os.hostname(),
    nonce,
    tree: '/planted/tree',
    command: 'run',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
  const file = path.join(claimDir, `${nonce}.json`);
  writeFileSync(file, `${JSON.stringify(claim)}\n`);
  return file;
}

function claimNames(claimDir) {
  return existsSync(claimDir) ? readdirSync(claimDir).sort() : [];
}

function withRepo(label, body) {
  const repo = makeRepo({ label });
  try {
    return body(repo, claimDirFor(repo.root));
  } finally {
    repo.cleanup();
  }
}

describe('the claim directory is derived from the git dir', () => {
  test('a repo locks under its own .git, which git status never reports', () => {
    withRepo('lock-path', (repo, claimDir) => {
      assert.equal(
        claimDir,
        path.join(repo.root, '.git', 'code-mutant-inplace.lock.d'),
        'the claim directory must live inside the git dir, so it is invisible to the clean-tree gate',
      );
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, true, 'an unlocked repo must be holdable');
      assert.equal(repo.status(), '', 'a published claim must not dirty the worktree');
      lock.release();
      assert.deepEqual(claimNames(claimDir), [], 'release must remove the claim');
    });
  });
});

describe('liveness, not mere claim existence', () => {
  // T3
  test('a dead claim never blocks', async () => {
    const dead = await reapedProcess();
    withRepo('lock-dead', (repo, claimDir) => {
      plantClaim(claimDir, dead);
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, true, 'a claim whose owner is gone must not block a new run');
      lock.release();
    });
  });

  // T4
  test('pid reuse does not block: liveness is the (pid, startTime) pair', () => {
    withRepo('lock-reuse', (repo, claimDir) => {
      const real = readStartTime(process.pid);
      assert.match(String(real), /^\d+$/, 'this platform must expose /proc for T4 to mean anything');
      plantClaim(claimDir, { pid: process.pid, startTime: String(Number(real) + 1) });
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(
        lock.held, true,
        'a live pid with a DIFFERENT start time is a reused pid, not the holder -- process.kill(pid, 0) alone is not liveness',
      );
      lock.release();
    });
  });

  // T5
  test('a matching (pid, startTime) is live and blocks', () => {
    withRepo('lock-live', (repo, claimDir) => {
      plantClaim(claimDir, { pid: process.pid, startTime: readStartTime(process.pid) });
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, false, 'a claim whose owner is running must block');
      assert.equal(lock.code, 'inplace-locked', 'the refusal must carry the named reason code');
      assert.equal(lock.holder.pid, process.pid, 'the refusal must identify the holder');
      assert.equal(lock.blockedBy, 1, 'exactly one claim blocked');
    });
  });

  // T7
  test('a foreign-host claim is never believed dead and never swept', async () => {
    const dead = await reapedProcess();
    withRepo('lock-foreign', (repo, claimDir) => {
      const file = plantClaim(claimDir, { ...dead, host: 'some-other-host' });
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(
        lock.held, false,
        'a pid liveness check about a different machine means nothing, so the claim must block',
      );
      assert.equal(lock.code, 'inplace-locked', 'the refusal carries the named code');
      assert.ok(existsSync(file), 'a claim we cannot prove dead must not be swept');
    });
  });

  // T8
  test('a malformed claim blocks rather than being ignored', () => {
    withRepo('lock-malformed', (repo, claimDir) => {
      mkdirSync(claimDir, { recursive: true });
      writeFileSync(path.join(claimDir, `${randomUUID()}.json`), '{');
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, false, 'an unclassifiable claim is treated as live -- fail closed');
      assert.equal(lock.code, 'inplace-locked', 'the refusal carries the named code');
      assert.equal(lock.holder, null, 'an unreadable claim names no holder');
      assert.equal(lock.blockedBy, 1, 'it still counts as a blocker');
    });
  });
});

describe('sweeping is bounded to claims proven dead', () => {
  // T9
  test('dead claims are swept, not merely ignored', async () => {
    const dead = await reapedProcess();
    withRepo('lock-sweep', (repo, claimDir) => {
      plantClaim(claimDir, dead);
      plantClaim(claimDir, dead);
      plantClaim(claimDir, dead);
      assert.equal(claimNames(claimDir).length, 3, 'three dead claims were planted');
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, true, 'dead claims must not block');
      assert.deepEqual(
        claimNames(claimDir), [`${lock.nonce}.json`],
        'a long-lived worktree must not accrue dead claims: only the holder\'s own claim remains',
      );
      lock.release();
    });
  });

  // T9b
  test('sweeping is decision-neutral under a live blocker', async () => {
    const dead = await reapedProcess();
    withRepo('lock-neutral', (repo, claimDir) => {
      const deadFile = plantClaim(claimDir, dead);
      const liveFile = plantClaim(claimDir, { pid: process.pid, startTime: readStartTime(process.pid) });
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, false, 'a sweep must never convert a refusal into a hold');
      assert.equal(lock.holder.pid, process.pid, 'the live claim is the holder named');
      assert.ok(!existsSync(deadFile), 'the dead claim is swept even on the refusing path');
      assert.ok(existsSync(liveFile), 'the live claim is untouched');
      assert.deepEqual(
        claimNames(claimDir), [path.basename(liveFile)],
        'a deferring process withdraws its own claim, or it would block the next invocation',
      );
    });
  });

  // T9c
  test('an unclassifiable claim blocks and is not swept', async () => {
    const dead = await reapedProcess();
    withRepo('lock-nosweep-malformed', (repo, claimDir) => {
      mkdirSync(claimDir, { recursive: true });
      const file = path.join(claimDir, `${randomUUID()}.json`);
      writeFileSync(file, '{');
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, false, 'a malformed claim blocks');
      assert.deepEqual(
        claimNames(claimDir), [path.basename(file)],
        'a claim we failed to parse must survive: rm-on-parse-failure would delete a live peer\'s claim',
      );
    });
    withRepo('lock-nosweep-foreign', (repo, claimDir) => {
      const file = plantClaim(claimDir, { ...dead, host: 'some-other-host' });
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'run' });
      assert.equal(lock.held, false, 'a foreign-host claim blocks');
      assert.deepEqual(
        claimNames(claimDir), [path.basename(file)],
        'a foreign-host claim must survive: its pid says nothing about this machine',
      );
    });
  });
});

describe('write-then-list admits exactly one holder', () => {
  // T10
  test('eight concurrent acquires elect one holder and the losers withdraw', async () => {
    const repo = makeRepo({ label: 'lock-race' });
    const claimDir = claimDirFor(repo.root);
    try {
      // Deterministic by construction, not by timing: acquireInPlaceLock is
      // wholly synchronous (linkSync/readdirSync/rmSync) and Node is
      // single-threaded, so Promise.all runs these eight to completion one after
      // another. The first sees an empty directory and holds; the other seven see
      // its claim and defer. No sleeps, no interleaving to arrange.
      const results = await Promise.all(Array.from({ length: 8 }, async () => (
        acquireInPlaceLock({ repoRoot: repo.root, command: 'run' })
      )));
      const held = results.filter((r) => r.held);
      assert.equal(held.length, 1, `exactly one acquire may hold, got ${held.length}`);
      for (const loser of results.filter((r) => !r.held)) {
        assert.equal(loser.code, 'inplace-locked', 'every loser refuses with the named code');
        assert.equal(loser.holder.pid, process.pid, 'every loser names the winner');
      }
      assert.deepEqual(
        claimNames(claimDir), [`${held[0].nonce}.json`],
        'only the winner\'s claim may remain -- seven deferring callers each withdrew their own',
      );
      held[0].release();
      assert.deepEqual(claimNames(claimDir), [], 'release empties the claim directory');
    } finally {
      repo.cleanup();
    }
  });
});

describe('the refusal text tells the reader what to do', () => {
  test('the detail names the holder, the tree, the claim directory and the escape', () => {
    withRepo('lock-detail', (repo, claimDir) => {
      plantClaim(claimDir, {
        pid: process.pid, startTime: readStartTime(process.pid), tree: repo.root, command: 'run',
      });
      const lock = acquireInPlaceLock({ repoRoot: repo.root, command: 'probe' });
      assert.equal(lock.held, false);
      assert.match(lock.detail, new RegExp(`pid ${process.pid}`), 'the holder pid must be named');
      assert.match(lock.detail, /`run`/, 'the holder command must be named');
      assert.match(lock.detail, /Nothing was mutated/, 'the reader must be told the tree is untouched');
      assert.match(lock.detail, /--copy/, 'the escape must be named');
      assert.ok(
        lock.detail.includes(claimDir),
        'the claim directory must be named, so a hand-cleared case is recoverable without reading the source',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Process-level: the genuine two-process case, and every exit shape.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');

const MUTANT = {
  id: 'locked',
  invariant: 'the user-defined-backend branch is load-bearing',
  sites: [{
    file: 'src/guard.mjs',
    anchor: "return kind === 'user-defined';",
    replacement: 'return false;',
  }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
  whyNotEquivalent: 'denies a backend the guard must admit',
};

function trackedBytes(root) {
  return Object.fromEntries(
    git(root, ['ls-files']).split('\n').filter(Boolean)
      .map((rel) => [rel, readFileSync(path.join(root, rel))]),
  );
}

function assertBytesUnchanged(before, after, why) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), `${why}: the tracked file set changed`);
  for (const rel of Object.keys(before)) {
    assert.ok(after[rel].equals(before[rel]), `${why}: ${rel} changed`);
  }
}

// A fixture whose test command is the staged fake, so the mutant run can be made
// to block on demand. Invocation 1 is the narrow baseline and returns green;
// invocation 2 is the mutant run and blocks, which is when the holder genuinely
// holds the lock WITH A MUTATION APPLIED.
function stagedRepo(label) {
  return makeRepo({
    files: guardFiles(),
    config: {
      baselineCommand: 'node --test',
      testCommand: `node ${JSON.stringify(STAGED)} {tests}`,
      isolation: 'in-place',
    },
    mutants: [MUTANT],
    label,
  });
}

// Deterministic without sleeping, exactly as restore-signal.test.mjs does it:
// wait for the marker (the command is running) AND for the mutated bytes on disk
// (the mutation is applied). Either alone would let the assertions pass with
// nothing to be excluded from.
async function startHolder(repo, scratch) {
  const stateFile = path.join(scratch, 'invocations');
  const markerFile = path.join(scratch, 'running');
  const child = spawn(process.execPath, [RUNNER, 'run', '--all', '--in-place', '--allow-dirty'], {
    cwd: repo.root,
    env: childEnv({ CM_FAKE_STATE: stateFile, CM_FAKE_BLOCK_ON: '2', CM_FAKE_MARKER: markerFile }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const exited = new Promise((resolve) => { child.on('close', (code, sig) => resolve({ code, sig })); });

  await waitFor(() => existsSync(markerFile), { what: 'the holder\'s mutant command to start' });
  await waitFor(
    () => readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8').includes('return false;'),
    { what: 'the holder\'s mutation to be visible on disk' },
  );
  return { child, exited, stateFile, markerFile };
}

// The blocked fake command is in the holder's process group; a SIGKILLed holder
// runs no cleanup, so the test reaps it rather than orphaning it.
async function reapMarkedChild(markerFile) {
  if (!existsSync(markerFile)) return;
  const pid = Number(readFileSync(markerFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { what: 'the orphaned fake command to be reaped' });
}

describe('a second in-place invocation against a live-held tree', () => {
  // T1
  test('refuses with inplace-locked, names the holder, and mutates nothing', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-lock-t1-'));
    const repo = stagedRepo('lock-t1');
    const claimDir = claimDirFor(repo.root);
    const committed = trackedBytes(repo.root);
    const holder = await startHolder(repo, scratch);
    try {
      // The precondition, asserted rather than assumed: without it the refusal
      // below could be about nothing at all.
      assert.ok(existsSync(holder.markerFile), 'the holder must be inside a measured command');
      assert.ok(
        readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8').includes('return false;'),
        'the holder must have its mutation applied, so this tree is genuinely poisoned',
      );

      const beforeB = trackedBytes(repo.root);
      const countBefore = readFileSync(holder.stateFile, 'utf8');

      const b = await runCli(['run', '--all', '--in-place', '--json'], {
        cwd: repo.root,
        env: { CM_FAKE_STATE: holder.stateFile, CM_FAKE_BLOCK_ON: '2' },
      });
      assert.equal(b.exitCode, 2, `the refusal must exit GATE_FAILED, got ${b.exitCode}:\n${b.stderr}`);
      const report = JSON.parse(b.stdout);
      const gate = report.gates.inPlaceLock;
      assert.equal(gate.code, 'inplace-locked', 'the named reason code');
      assert.equal(gate.outcome, 'failed', 'the gate must read FAILED');
      assert.equal(gate.holder.pid, holder.child.pid, 'the refusal must identify the holding process');
      assert.equal(gate.claimDir, claimDir, 'the refusal must name the claim directory');
      // Without the ordering this would read `dirty-tree` -- the holder's own
      // mutation dirties the tree -- and name no holder at all.
      assert.equal(
        report.gates.cleanTree, undefined,
        'the lock must refuse BEFORE the clean-tree gate, or the reader is misdirected',
      );

      assert.equal(
        readFileSync(holder.stateFile, 'utf8'), countBefore,
        'the refused run must not invoke the test command even once',
      );
      assertBytesUnchanged(beforeB, trackedBytes(repo.root), 'the refused run');

      const text = await runCli(['run', '--all', '--in-place'], {
        cwd: repo.root,
        env: { CM_FAKE_STATE: holder.stateFile, CM_FAKE_BLOCK_ON: '2' },
      });
      assert.match(text.stdout, /in-place-lock\s+FAILED/, 'the printed gate block must carry the row');
      assert.match(text.stdout, /THE HARNESS IS NOT TRUSTWORTHY/, 'the not-trustworthy banner must fire');

      holder.child.kill('SIGTERM');
      await holder.exited;
      assertBytesUnchanged(committed, trackedBytes(repo.root), 'the holder\'s restore');
      assert.deepEqual(
        claimNames(claimDir), [],
        'both claims must be gone: the holder released, and each refusal withdrew its own',
      );
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
      await reapMarkedChild(holder.markerFile);
      repo.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // T1b
  test('a SIGKILLed holder leaves a dead claim that does not wedge the tree', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-lock-t1b-'));
    const repo = stagedRepo('lock-t1b');
    const claimDir = claimDirFor(repo.root);
    const holder = await startHolder(repo, scratch);
    try {
      holder.child.kill('SIGKILL');
      await holder.exited;
      await reapMarkedChild(holder.markerFile);
      assert.equal(claimNames(claimDir).length, 1, 'a SIGKILLed holder runs no cleanup, so its claim leaks');

      const b = await runCli(['run', '--all', '--in-place', '--json'], {
        cwd: repo.root,
        env: { CM_FAKE_STATE: holder.stateFile, CM_FAKE_BLOCK_ON: '2' },
      });
      const report = JSON.parse(b.stdout);
      assert.equal(
        report.gates.inPlaceLock.outcome, 'passed',
        'a dead holder must not block the next invocation, or a crash needs a human with rm',
      );
      assert.equal(report.gates.inPlaceLock.code, null, 'a passed lock gate carries no code');
      // Card 2026-0044's boundary, asserted so it reads as deliberate: this lock
      // only has to be RECLAIMABLE after a crash. Repairing a tree a dead process
      // left mutated is not its job, and the clean-tree gate still catches it.
      assert.equal(
        report.gates.cleanTree.code, 'dirty-tree',
        'the SIGKILLed holder left its mutation in the tree, which clean-tree must still catch',
      );
      assert.deepEqual(claimNames(claimDir), [], 'the dead claim is swept and the sweeper released its own');
    } finally {
      repo.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('copy isolation is untouched by the lock', () => {
  // T2
  test('two concurrent copy runs on one repo both proceed, and neither takes a lock', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { isolation: 'copy' },
      mutants: [MUTANT],
      label: 'lock-t2-copy',
    });
    try {
      // Warmed first, so the two concurrent runs both HIT the gate cache and
      // neither writes one: `writeGateEntry` stages through a fixed `<file>.tmp`
      // name, so two processes filing the same key is its own race and not the
      // one under test here.
      const warm = await runCli(['run', '--all', '--copy', '--json'], { cwd: repo.root });
      assert.notEqual(warm.exitCode, 2, `the warm-up run must not fail a gate:\n${warm.stderr}`);

      const [a, b] = await Promise.all([
        runCli(['run', '--all', '--copy', '--json'], { cwd: repo.root }),
        runCli(['run', '--all', '--copy', '--json'], { cwd: repo.root }),
      ]);
      for (const [label, result] of [['A', a], ['B', b]]) {
        assert.notEqual(result.exitCode, 2, `copy run ${label} must not be gate-refused:\n${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(
          report.gates.inPlaceLock, undefined,
          `copy run ${label} must not record an in-place lock gate -- the lock is scoped to in-place`,
        );
      }
    } finally {
      repo.cleanup();
    }
  });

  test('copy mode with --jobs 2 still reports jobs 2 and takes no lock', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { isolation: 'copy' },
      mutants: [MUTANT],
      label: 'lock-t2-jobs',
    });
    try {
      const result = await runCli(['run', '--all', '--copy', '--jobs', '2', '--json'], { cwd: repo.root });
      const report = JSON.parse(result.stdout);
      assert.equal(report.jobs, 2, 'copy mode must still run jobs > 1');
      assert.equal(
        report.gates.inPlaceLock, undefined,
        'a lock keyed on the repo rather than the isolation mode would appear here',
      );
    } finally {
      repo.cleanup();
    }
  });
});

describe('every exit shape releases the claim', () => {
  // T6a
  test('a normal green run releases, and the next sequential run is not refused', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { isolation: 'in-place' },
      mutants: [MUTANT],
      label: 'lock-t6-green',
    });
    const claimDir = claimDirFor(repo.root);
    try {
      const first = await runCli(['run', '--all', '--in-place', '--json'], { cwd: repo.root });
      assert.notEqual(first.exitCode, 2, `the first run must pass its gates:\n${first.stderr}`);
      assert.equal(JSON.parse(first.stdout).gates.inPlaceLock.outcome, 'passed', 'the first run holds the lock');
      assert.deepEqual(claimNames(claimDir), [], 'a normal exit must leave no claim');

      const second = await runCli(['run', '--all', '--in-place', '--json'], { cwd: repo.root });
      assert.notEqual(
        second.exitCode, 2,
        `a sequential re-run must not be refused by the previous run's claim:\n${second.stderr}`,
      );
      assert.equal(JSON.parse(second.stdout).gates.inPlaceLock.code, null, 'the re-run holds the lock too');
    } finally {
      repo.cleanup();
    }
  });

  // T6b -- pins the try/finally wrap: the claim is published BEFORE the
  // clean-tree gate, so it must still be withdrawn on that early `return report`.
  test('a gate refusal releases the claim it published before the gate', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { isolation: 'in-place' },
      mutants: [MUTANT],
      label: 'lock-t6-dirty',
    });
    const claimDir = claimDirFor(repo.root);
    try {
      appendFileSync(path.join(repo.root, 'src/guard.mjs'), '\n// uncommitted\n');
      const result = await runCli(['run', '--all', '--in-place', '--json'], { cwd: repo.root });
      assert.equal(result.exitCode, 2, 'a dirty tree without --allow-dirty must fail a gate');
      const report = JSON.parse(result.stdout);
      assert.equal(report.gates.inPlaceLock.outcome, 'passed', 'the lock was held: nothing else was running');
      assert.equal(report.gates.cleanTree.code, 'dirty-tree', 'the refusal is the clean-tree gate\'s');
      assert.deepEqual(claimNames(claimDir), [], 'the early return must still release the claim');
    } finally {
      repo.cleanup();
    }
  });

  // T6c/T6d
  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} mid-command releases the claim and restores the tree`, async () => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), `code-mutant-lock-${signal}-`));
      const repo = stagedRepo(`lock-t6-${signal}`);
      const claimDir = claimDirFor(repo.root);
      const committed = trackedBytes(repo.root);
      const holder = await startHolder(repo, scratch);
      try {
        assert.equal(claimNames(claimDir).length, 1, 'the running holder must have a claim published');
        holder.child.kill(signal);
        await holder.exited;
        assert.deepEqual(claimNames(claimDir), [], `${signal} must release the claim`);
        // The lock registers its cleanup BEFORE any snapshot, and cleanups run in
        // reverse registration order, so the claim is dropped only after the tree
        // is back: no other process is ever admitted to a still-mutated tree.
        assertBytesUnchanged(committed, trackedBytes(repo.root), `the ${signal} restore`);
      } finally {
        holder.child.kill('SIGKILL');
        await holder.exited;
        await reapMarkedChild(holder.markerFile);
        repo.cleanup();
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
});
