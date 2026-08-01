#!/usr/bin/env node
// A fake test command whose behaviour depends on how many times it has been
// invoked, so a test can drive the runner through a specific sequence without
// sleeping or racing.
//
// Injected via env vars (the project convention for faking an expensive external
// command):
//   CM_FAKE_STATE   path to the counter file (required)
//   CM_FAKE_BLOCK_ON  1-based invocation number that should BLOCK instead of
//                     returning. Used by the SIGTERM test: invocation 1 is the
//                     narrow baseline and must return green, invocation 2 is the
//                     mutant run and must hang so the test can signal mid-command.
//   CM_FAKE_MARKER  file to create just before blocking, so the test can wait for
//                   "the command is running" instead of guessing.
//   CM_FAKE_ALWAYS_GREEN  emit green counted output on every invocation. Used by
//                     the canary negative control: a command that reports success
//                     no matter what the tree says.
//
// Output is `node --test` spec-reporter shaped, so the node-test adapter parses it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const state = process.env.CM_FAKE_STATE;
if (!state) {
  process.stderr.write('staged-command.mjs: CM_FAKE_STATE is required\n');
  process.exit(64);
}

const count = (existsSync(state) ? Number(readFileSync(state, 'utf8').trim()) || 0 : 0) + 1;
writeFileSync(state, `${count}\n`);

function green() {
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
}

if (process.env.CM_FAKE_ALWAYS_GREEN === '1') {
  green();
  process.exit(0);
}

if (process.env.CM_FAKE_BLOCK_ON && count === Number(process.env.CM_FAKE_BLOCK_ON)) {
  if (process.env.CM_FAKE_MARKER) writeFileSync(process.env.CM_FAKE_MARKER, `${process.pid}\n`);
  // Block on a timer that never fires rather than a real sleep: nothing here
  // depends on wall-clock time, the test kills this process to end it.
  setInterval(() => {}, 1 << 30);
} else {
  green();
  process.exit(0);
}
