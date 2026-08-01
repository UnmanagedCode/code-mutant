// Runs the real CLI as a child process, which is the only way to observe the
// thing a conductor actually gates on: the exit code.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER = path.resolve(HERE, '..', '..', 'mutate.mjs');

// The child must not inherit the parent test runner's NODE_TEST_CONTEXT, or a
// fixture's own `node --test` would switch reporters and parse as zero tests.
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

export function runCli(args, { cwd, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RUNNER, ...args],
      { cwd, env: childEnv(env), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error?.code ?? 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}
