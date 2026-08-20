#!/usr/bin/env node
// A fake test command that EXITS but leaves its stdout pipe held open by a
// grandchild -- the 2026-0183 failure shape, reproduced deterministically.
//
// `close` on the parent side fires only when every holder of the pipe's write end
// is gone. A test command that backgrounds a worker inheriting stdout therefore
// leaves `close` unfired indefinitely, even though the command itself is finished.
//
// The grandchild is spawned NOT detached, deliberately: it stays in the process
// group runCommand kills on settle, so nothing outlives the test. Detaching it
// would give it its own group and leak a live process past every run.
//
//   CM_LEAK_WRITE=1  the grandchild keeps WRITING, not merely holding the pipe --
//                    the case where settling early really would under-capture.
//   CM_LEAK_MS       how long the grandchild lives. Default 10000.

import { spawn } from 'node:child_process';

const lifetimeMs = Number(process.env.CM_LEAK_MS ?? 10_000);
const script = process.env.CM_LEAK_WRITE === '1'
  ? `setInterval(() => process.stdout.write('late noise\\n'), 5); setTimeout(() => process.exit(0), ${lifetimeMs});`
  : `setTimeout(() => process.exit(0), ${lifetimeMs});`;

// stdout is INHERITED: the grandchild gets a dup of this process's fd 1, which is
// the pipe runCommand is reading. That dup is what keeps `close` from firing.
const grandchild = spawn(process.execPath, ['-e', script], {
  detached: false,
  stdio: ['ignore', 'inherit', 'ignore'],
});
grandchild.unref();

process.stdout.write([
  '✔ fake test (0.1ms)',
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

process.exit(0);
