#!/usr/bin/env node
// A fake test command that records what the tree looked like WHILE it ran, then
// reports green.
//
// Without this, a restore test can pass trivially: "the created file is absent
// afterwards" is also true if the patch was never applied. Recording the mid-run
// state turns the assertion into "it was really there during the run, and really
// gone after", which is the property that matters.
//
//   CM_OBSERVE_PATHS  comma-separated repo-relative paths to inspect
//   CM_OBSERVE_OUT    file to write the observation JSON to (outside the repo)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { answerCanary } from './fake-canary.mjs';

// The canary gate now runs the command that JUDGES each mutant, so this fake
// answers the synthesised canary before it does anything else -- a fake that
// reported green with a guaranteed-failing test injected would be refused, and
// answering FIRST is what keeps a canary invocation out of everything below
// (here: out of the observation file, which it would otherwise overwrite with an
// unmutated reading).
if (answerCanary()) process.exit(1);

const paths = (process.env.CM_OBSERVE_PATHS ?? '').split(',').map((p) => p.trim()).filter(Boolean);
const out = process.env.CM_OBSERVE_OUT;

if (out) {
  const observed = {};
  for (const rel of paths) {
    const abs = path.resolve(process.cwd(), rel);
    observed[rel] = existsSync(abs)
      ? { exists: true, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') }
      : { exists: false, sha256: null };
  }
  writeFileSync(out, `${JSON.stringify({ cwd: process.cwd(), observed }, null, 2)}\n`);
}

process.stdout.write([
  '✔ fake observation (0.1ms)',
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
