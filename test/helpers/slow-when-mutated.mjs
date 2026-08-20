#!/usr/bin/env node
// A fake test command that costs a MULTIPLE of its own unmutated cost when the
// mutation is present. It exists for one test claim: a mutant that legitimately
// runs slower than its reference must still grade normally.
//
// Why it reads the file rather than counting invocations. The narrow baseline and
// the mutant run issue the SAME command string, so the only thing that can tell
// them apart is the fact that actually differs -- whether the mutation is on disk.
// An invocation ordinal would also work here, but it breaks the moment anything
// upstream changes how many commands run first.
//
// Why iterations and not a sleep. The claim being pinned is a RATIO between two
// measurements from the same run. A sleep holds constant while the machine's own
// cost varies, so the ratio it produces is an artifact; a fixed iteration count
// scales with the machine exactly as the surrounding cost does.
//
// Injected via env vars (the project convention for faking an expensive command):
//   CM_SLOW_FILE        relative path of the mutant's site file
//   CM_SLOW_NEEDLE      the replacement text -- present in the file means MUTATED
//   CM_SLOW_ITERATIONS  iterations when unmutated; mutated runs 4x that
//   CM_SLOW_FAIL_TEST   the test id to report as failed, when mutated
//
// Output is `node --test` spec-reporter shaped, so the node-test adapter parses it.

import { readFileSync } from 'node:fs';

const file = process.env.CM_SLOW_FILE;
const needle = process.env.CM_SLOW_NEEDLE;
const iterations = Number(process.env.CM_SLOW_ITERATIONS ?? 0);
const failTest = process.env.CM_SLOW_FAIL_TEST;

if (!file || !needle || !failTest) {
  process.stderr.write('slow-when-mutated.mjs: CM_SLOW_FILE, CM_SLOW_NEEDLE and CM_SLOW_FAIL_TEST are required\n');
  process.exit(64);
}

const mutated = readFileSync(file, 'utf8').includes(needle);
const rounds = mutated ? iterations * 4 : iterations;

let hash = 7;
for (let i = 0; i < rounds; i += 1) hash = (hash * 31 + i) % 2147483647;

function summary({ pass, fail }) {
  return [
    `ℹ tests ${pass + fail}`,
    'ℹ suites 0',
    `ℹ pass ${pass}`,
    `ℹ fail ${fail}`,
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    `ℹ duration_ms ${hash % 2}`,
    '',
  ].join('\n');
}

if (mutated) {
  // Shaped for lib/adapters/node-test.mjs: the inline block first, then the
  // counters, then the `failing tests:` marker with a `test at <file>` line above
  // the repeated ✖ -- that pairing is what gives the failure its file::name id.
  const at = failTest.indexOf('::');
  const [file_, name] = at === -1 ? [failTest, failTest] : [failTest.slice(0, at), failTest.slice(at + 2)];
  process.stdout.write([
    `✖ ${name} (0.1ms)`,
    summary({ pass: 0, fail: 1 }),
    '✖ failing tests:',
    '',
    `test at ${file_}:1:1`,
    `✖ ${name} (0.1ms)`,
    '',
  ].join('\n'));
  process.exit(1);
}

process.stdout.write(['✔ unmutated (0.1ms)', summary({ pass: 1, fail: 0 })].join('\n'));
process.exit(0);
