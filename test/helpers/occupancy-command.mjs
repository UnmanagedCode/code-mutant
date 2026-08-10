#!/usr/bin/env node
// A fake test command that records WHICH TREE it ran in and WHAT WAS MUTATED
// THERE while it ran, so a test can assert on mid-run state instead of inferring
// concurrency from the final tree.
//
// ORDERING. The log is JSON Lines and its AUTHORITATIVE ORDER IS LINE ORDER IN
// THE FILE. Every record is one `appendFileSync` of one line to a file opened
// O_APPEND, which is atomic for writes this small, so line order across processes
// reflects the order the events happened. There is deliberately NO sequence
// counter: a counter in a subprocess can only ever be per-process, and mixing a
// per-process counter with cross-process interval detection would silently
// mis-order overlapping runs. `pid` is identity only, never order.
//
// TREE SIDE EFFECTS. This stands in for `node --test <file>`, which READS the
// source files and writes nothing into the tree. This fake reads the same source
// files and likewise writes nothing into any workspace -- its log and release
// files are absolute paths in a scratch directory outside every workspace and
// outside the repo. That is the real command's full set of tree side effects, and
// it is the sufficient set here: the properties under test are about bytes the
// RUNNER writes (apply and restore), so a fake that wrote into the tree would be
// adding a contaminant the real command does not have and testing the wrong
// thing. (test/concurrency-guards.test.mjs uses fakes that DO write into the
// tree, deliberately, to stand in for a contaminating command.)
//
// Injected via env vars (the project convention for faking an expensive external
// command):
// THE RENDEZVOUS IS TWO-WAY, on purpose. The blocker announces that it is
// blocking and only then waits; the releaser waits for that announcement before
// releasing. A one-way block (releaser just writes the file) would leave the
// overlap depending on which child process starts faster -- if the releaser got
// all the way through first, the blocker would never block and the test would
// silently stop forcing anything. Two-way makes "these two runs overlapped" true
// by construction rather than by timing, with both waits bounded so a broken run
// fails loudly instead of hanging.
//
//   CM_OCC_LOG            JSONL log to append to (required)
//   CM_OCC_SITES          comma-separated repo-relative source paths to inspect
//   CM_OCC_MARKER         substring marking a site file as currently mutated
//   CM_OCC_BLOCK_SCOPE    the {tests} argument whose MUTANT run should block
//   CM_OCC_BLOCKED        file the blocker creates to announce it is blocking
//   CM_OCC_RELEASE_SCOPE  the {tests} argument whose MUTANT run releases the block
//   CM_OCC_RELEASE        the release file both of those coordinate through
//   CM_OCC_DEADLINE_MS    bound on either wait, so a broken run fails loudly
//                         instead of hanging (default 20000)
//   CM_OCC_CONTAMINATE_SCOPE  the {tests} argument whose MUTANT run writes foreign
//                         bytes into CM_OCC_CONTAMINATE_PATH and leaves them there,
//                         standing in for a concurrent mutant's restore-to-a-
//                         mutated-snapshot. The only case where this fake writes
//                         into the tree (see TREE SIDE EFFECTS above).
//   CM_OCC_CONTAMINATE_PATH   repo-relative path to contaminate
//
// All coordination is gated on "at least one site file is currently mutated",
// which is what distinguishes a MUTANT run from the unmutated narrow-baseline
// runs of the same command in phase A. Without that gate the phase A baselines
// would block and the run would deadlock.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const log = process.env.CM_OCC_LOG;
const scope = process.argv[2] ?? '(no scope)';
const marker = process.env.CM_OCC_MARKER ?? 'MUTATED_';
const sites = (process.env.CM_OCC_SITES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function record(fields) {
  if (!log) return;
  appendFileSync(log, `${JSON.stringify({ cwd: process.cwd(), scope, pid: process.pid, ...fields })}\n`);
}

// Which site files carry a mutation RIGHT NOW, read from this process's cwd --
// i.e. from whichever workspace the runner chose for this mutant.
function mutatedSites() {
  return sites.filter((rel) => {
    try {
      return readFileSync(path.resolve(process.cwd(), rel), 'utf8').includes(marker);
    } catch {
      return false;
    }
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const mutated = mutatedSites();
record({ phase: 'enter', mutated });

// Bounded wait for a file. Returns false on deadline, so the caller can log a
// `timeout` record and fail the run loudly rather than hanging the suite.
function waitForFile(file) {
  const deadline = Date.now() + Number(process.env.CM_OCC_DEADLINE_MS ?? 20_000);
  while (!existsSync(file)) {
    if (Date.now() > deadline) return false;
    sleep(10);
  }
  return true;
}

function giveUp(what) {
  record({ phase: 'timeout', mutated, waitingFor: what });
  process.stderr.write(`occupancy-command: ${scope} never saw ${what}\n`);
  process.exit(70);
}

if (mutated.length) {
  if (scope === process.env.CM_OCC_CONTAMINATE_SCOPE && process.env.CM_OCC_CONTAMINATE_PATH) {
    writeFileSync(
      path.resolve(process.cwd(), process.env.CM_OCC_CONTAMINATE_PATH),
      "export function value() {\n  return 'FOREIGN_RESIDUE';\n}\n",
    );
  }

  if (scope === process.env.CM_OCC_RELEASE_SCOPE && process.env.CM_OCC_RELEASE) {
    // Wait until the blocker is demonstrably blocked before releasing it, so the
    // two runs provably overlap however the processes happen to be scheduled.
    if (process.env.CM_OCC_BLOCKED && !waitForFile(process.env.CM_OCC_BLOCKED)) {
      giveUp('the blocked marker');
    }
    appendFileSync(process.env.CM_OCC_RELEASE, `${process.pid}\n`);
  }

  if (scope === process.env.CM_OCC_BLOCK_SCOPE && process.env.CM_OCC_RELEASE) {
    if (process.env.CM_OCC_BLOCKED) writeFileSync(process.env.CM_OCC_BLOCKED, `${process.pid}\n`);
    if (!waitForFile(process.env.CM_OCC_RELEASE)) giveUp('its release file');
  }
}

record({ phase: 'exit', mutated });

process.stdout.write([
  '✔ fake occupancy probe (0.1ms)',
  'ℹ tests 1',
  'ℹ suites 0',
  'ℹ pass 1',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 1',
  '',
].join('\n'));
