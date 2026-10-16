// Runs a project command and captures its output. Every command the runner
// issues -- baseline, canary, narrowed scope, setup/teardown -- goes through
// here, so the timeout and the process-group kill exist once.
//
// Children are spawned `detached` so each gets its own process group, and both
// the timeout and the signal path kill the whole group. A project's test command
// is normally a shell that forks a real runner; killing only the shell would
// leave that runner alive, still reading a mutated file, while restore runs
// underneath it.

import { spawn } from 'node:child_process';

// Shared by every byte a measured command produces -- stdout, stderr, and any
// report files it writes (lib/reports.mjs) -- so a report cannot bypass the cap.
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// Variables a parent test runner exports to its children, which would silently
// change the output format of a project command. `node --test` sets
// NODE_TEST_CONTEXT=child-v8, and a nested `node --test` that inherits it switches
// from the spec reporter to a machine reporter -- so the adapter would parse zero
// tests and every mutant would read ERROR (scope-empty) for reasons having nothing
// to do with the project. Stripped rather than passed through: the project's test
// command must see the environment it would see from a shell.
const INHERITED_TEST_RUNNER_VARS = ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID'];

export function cleanEnv(source = process.env) {
  const env = { ...source };
  for (const name of INHERITED_TEST_RUNNER_VARS) delete env[name];
  return env;
}

const live = new Set();

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // No process group (or already reaped) -- fall back to the child itself.
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// Called from the exit/signal guard before restore: nothing may still be reading
// a mutated file while the bytes are being put back.
export function killAllChildrenSync() {
  for (const child of live) killGroup(child, 'SIGKILL');
  live.clear();
}

export function liveChildCount() {
  return live.size;
}

function collect(stream, chunks, state) {
  stream.on('data', (chunk) => {
    if (state.bytes >= MAX_CAPTURE_BYTES) { state.truncated = true; return; }
    state.bytes += chunk.length;
    chunks.push(chunk);
  });
}

// How long to keep waiting for `close` after the child has already exited. Not a
// config.json key: it is a property of how pipes drain, not of a project, so
// exposing it would add a project-facing knob nobody can tune meaningfully.
// Overridable per call for the tests that pin the two branches.
const DEFAULT_DRAIN_GRACE_MS = 2000;

// Resolves (never rejects) with the outcome, so a non-zero exit or a timeout is
// data for the classifier rather than an exception for the caller to translate.
//
// `detached: false` keeps the child in the CALLER's process group, for a caller
// that is itself a measured command (lib/route-exec.mjs): the runner's group
// kill on timeout or signal then reaches the child too. Such a child is not a
// group leader, so the group kill on settle is skipped -- the caller's own
// group is the one that gets reaped.
export function runCommand(command, {
  cwd, timeoutMs = 120_000, env = null, drainGraceMs = DEFAULT_DRAIN_GRACE_MS, detached = true,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(command, {
      cwd,
      env: env ?? cleanEnv(),
      shell: '/bin/sh',
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(child);

    const outChunks = [];
    const errChunks = [];
    const state = { bytes: 0, truncated: false };
    collect(child.stdout, outChunks, state);
    collect(child.stderr, errChunks, state);

    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killGroup(child, 'SIGKILL'); }, timeoutMs)
      : null;

    let outputIncomplete = false;
    let drainTimer = null;

    let settled = false;
    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      live.delete(child);
      // The group can outlive the direct child (a shell that backgrounded work);
      // reap it unconditionally so nothing survives this call.
      if (detached) killGroup(child, 'SIGKILL');
      resolve({
        command,
        cwd,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: exitCode ?? (signal ? 128 : 1),
        signal: signal ?? null,
        timedOut,
        truncated: state.truncated,
        capturedBytes: state.bytes,
        outputIncomplete,
        spawnError: spawnError ? (spawnError.message ?? String(spawnError)) : null,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    };

    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal, null));

    // `close` waits for every stdio stream to CLOSE, which needs every holder of
    // the write end gone -- not just this child. A test command that backgrounds
    // a worker inheriting stdout therefore leaves `close` unfired long after the
    // command itself finished, and the promise sat until the timeout killed the
    // group. That is the exact 2026-0183 shape: "the per-file abort fired, but an
    // unsettled promise kept handles open, so the file never reported."
    //
    // So `exit` starts a bounded grace instead. Nothing new is being produced by
    // this child once it has exited, so a pipe that has not closed within the
    // grace is being held by something else -- and `killGroup` on settle reaps
    // whatever that is.
    //
    // Settling early can never manufacture a green read: `outputIncomplete` is
    // treated exactly as `truncated` is, one layer up. Complete-output runs are
    // unaffected, because `close` beats the grace whenever it is going to fire at
    // all.
    child.on('exit', (code, signal) => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => {
        outputIncomplete = true;
        finish(code, signal, null);
      }, drainGraceMs);
    });
  });
}
