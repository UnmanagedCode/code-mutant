// The instrument for "how many times did the expensive command run".
//
// Reads the log test/helpers/counting-command.mjs appends to, and counts
// WHOLE-SUITE invocations -- entries with no argv -- separately from narrow ones.
// That is a fact about commands rather than about the wall clock, which
// CONVENTIONS forbids asserting on.
//
// One owner, shared by every claim that measures gate cost: the gate cache's and
// the narrowed canary's, which are two halves of the same cost question and must
// not count differently.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Scoped to ONE invocation: `reset()` truncates the log, so a claim reads the
// commands run 2 issued and not run 1's as well.
export function makeCounter() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-count-'));
  const file = path.join(scratch, 'commands.jsonl');
  return {
    env: { CM_COUNT_LOG: file },
    reset() { writeFileSync(file, ''); },
    entries() {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    wholeSuite() { return this.entries().filter((e) => e.args.length === 0).length; },
    cleanup() { rmSync(scratch, { recursive: true, force: true }); },
  };
}
