#!/usr/bin/env node
// A pass-through that records WHICH SCOPE each measured command ran against,
// then runs the real thing.
//
// It fakes nothing and hides nothing: it appends its argv to CM_COUNT_LOG
// (JSON Lines) and forwards to `node --test --test-concurrency=1 <args>`,
// including stdio and exit code, so the adapter parses genuine output.
//
// Wired as `baselineCommand: node counting-command.mjs` (no args) and
// `testCommand: node counting-command.mjs {tests}` (the scope), a test can count
// WHOLE-SUITE invocations -- the baseline gate plus each canary attempt that
// actually ran -- separately from narrow ones. That count is the instrument the
// gate cache has to be measured with: "how many times did the expensive command
// run" is the claim, and it is a fact about commands rather than about the wall
// clock, which CONVENTIONS forbids asserting on.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
if (process.env.CM_COUNT_LOG) {
  appendFileSync(process.env.CM_COUNT_LOG, `${JSON.stringify({ args })}\n`);
}

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...args], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
