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

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

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

// Resolves (never rejects) with the outcome, so a non-zero exit or a timeout is
// data for the classifier rather than an exception for the caller to translate.
export function runCommand(command, { cwd, timeoutMs = 120_000, env = null } = {}) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(command, {
      cwd,
      env: env ?? cleanEnv(),
      shell: '/bin/sh',
      detached: true,
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

    let settled = false;
    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      live.delete(child);
      // The group can outlive the direct child (a shell that backgrounded work);
      // reap it unconditionally so nothing survives this call.
      killGroup(child, 'SIGKILL');
      resolve({
        command,
        cwd,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: exitCode ?? (signal ? 128 : 1),
        signal: signal ?? null,
        timedOut,
        truncated: state.truncated,
        spawnError: spawnError ? (spawnError.message ?? String(spawnError)) : null,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    };

    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}
