// AN INTERRUPTED RUN MUST NOT LEAVE A MUTATION BEHIND.
//
// Restore is wired to exit/SIGINT/SIGTERM, so this drives the real CLI as a child
// process, waits until the mutation is genuinely applied and the command is
// genuinely running, then signals it -- and asserts the tree came back with the
// uncommitted edit intact.
//
// Deterministic without sleeping: the fake test command writes a marker file just
// before it blocks, and the test polls for that marker AND for the mutated bytes
// being visible on disk. Nothing here waits out a delay.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { guardFiles, makeRepo, readBytes } from './helpers/tmp-repo.mjs';

import { waitFor } from './helpers/wait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const RUNNER = path.join(REPO_ROOT, 'mutate.mjs');
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');

const UNCOMMITTED = '\n// UNCOMMITTED WORK -- must survive an interrupted run\n';

// The child must not inherit the parent test runner's NODE_TEST_CONTEXT, or the
// fixture's own `node --test` baseline would switch reporters.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

const MUTANT = {
  id: 'interrupted',
  invariant: 'the user-defined-backend branch is load-bearing',
  sites: [{
    file: 'src/guard.mjs',
    anchor: "return kind === 'user-defined';",
    replacement: 'return false;',
  }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
  whyNotEquivalent: 'denies a backend the guard must admit',
};

async function interruptMidRun(signal) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-signal-'));
  const stateFile = path.join(scratch, 'invocations');
  const markerFile = path.join(scratch, 'running');

  const repo = makeRepo({
    files: guardFiles(),
    // Invocation 1 is the narrow baseline and returns green; invocation 2 is the
    // mutant run and blocks, which is the moment we want to interrupt.
    config: {
      baselineCommand: 'node --test',
      testCommand: `node ${JSON.stringify(STAGED)} {tests}`,
      isolation: 'in-place',
    },
    mutants: [MUTANT],
    label: `signal-${signal}`,
  });

  appendFileSync(path.join(repo.root, 'src/guard.mjs'), UNCOMMITTED);
  {
    const bytesBefore = readBytes(repo.root, 'src/guard.mjs');
    const statusBefore = repo.status();

    const child = spawn(process.execPath, [RUNNER, 'run', '--all', '--in-place'], {
      cwd: repo.root,
      env: childEnv({
        CM_FAKE_STATE: stateFile,
        CM_FAKE_BLOCK_ON: '2',
        CM_FAKE_MARKER: markerFile,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', () => {});

    const exited = new Promise((resolve) => {
      child.on('close', (code, sig) => resolve({ code, sig }));
    });

    // Wait for BOTH: the command is running, and the mutation is on disk. Either
    // alone would leave the assertion able to pass without a mutation to restore.
    await waitFor(() => existsSync(markerFile), { what: 'the mutant command to start' });
    await waitFor(
      () => readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8').includes('return false;'),
      { what: 'the mutation to be visible on disk' },
    );

    child.kill(signal);
    const { code } = await exited;

    return {
      repo, bytesBefore, statusBefore, code, stderr, markerFile,
      cleanup() {
        repo.cleanup();
        rmSync(scratch, { recursive: true, force: true });
      },
    };
  }
}

describe('interrupted runs restore the tree', () => {
  test('SIGTERM mid-command restores byte-identically, uncommitted edit intact', async () => {
    const result = await interruptMidRun('SIGTERM');
    const { repo } = result;
    try {
      const bytesAfter = readBytes(repo.root, 'src/guard.mjs');
      assert.ok(
        bytesAfter.equals(result.bytesBefore),
        `the interrupted run left the file changed:\n${bytesAfter.toString('utf8')}`,
      );
      assert.ok(
        bytesAfter.toString('utf8').includes('UNCOMMITTED WORK'),
        'the uncommitted edit must survive an interrupted run too',
      );
      assert.equal(repo.status(), result.statusBefore, 'git status --porcelain must be unchanged');
      assert.match(result.stderr, /restoring the tree before exit/, 'the restore should be announced');
      assert.match(result.stderr, /tree restored/);
      assert.equal(result.code, 143, 'SIGTERM should exit 143 after restoring');
    } finally { result.cleanup(); }
  });

  test('SIGINT mid-command restores too', async () => {
    const result = await interruptMidRun('SIGINT');
    const { repo } = result;
    try {
      assert.ok(readBytes(repo.root, 'src/guard.mjs').equals(result.bytesBefore));
      assert.equal(repo.status(), result.statusBefore);
      assert.equal(result.code, 130, 'SIGINT should exit 130 after restoring');
    } finally { result.cleanup(); }
  });

  test('the blocked child process is reaped, not orphaned holding a mutated file', async () => {
    const result = await interruptMidRun('SIGTERM');
    const { repo } = result;
    try {
      const pid = Number(readFileSync(result.markerFile, 'utf8').trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }, { what: 'the blocked child to be reaped' });
    } finally { result.cleanup(); }
  });
});
