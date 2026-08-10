#!/usr/bin/env node
// A fake test command that WRITES INTO THE TREE while it runs, then reports green.
//
// TREE SIDE EFFECTS, and why these are the right ones. Unlike
// occupancy-command.mjs, this fake deliberately does not reproduce a normal test
// command's side effects (none). It stands in for the OTHER actor in the race:
// a concurrent mutant's apply or restore landing in this tree mid-run. That actor
// really does write source bytes while a measured command is in flight, and it is
// the only side effect that matters for the guards under test, which are entirely
// about on-disk source state. Faking it in-process makes the interleave exact
// instead of racing two real runs and hoping for the ordering.
//
// It reports GREEN in both modes on purpose: green is what turns an unguarded run
// into a false SURVIVED, so a guard that only fired on a red run would prove
// nothing.
//
//   CM_TAMPER_MODE    'revert'      -- overwrite CM_TAMPER_PATH with the bytes in
//                                      CM_TAMPER_CONTENT (a file outside the tree),
//                                      i.e. undo the mutation under the running
//                                      command, exactly as a concurrent restore does.
//                     'contaminate' -- overwrite CM_TAMPER_PATH with foreign bytes
//                                      and LEAVE them there, exactly as a concurrent
//                                      mutant's restore-to-mutated-snapshot does.
//   CM_TAMPER_SCOPE   only tamper when argv[2] is this {tests} value, so exactly
//                     one mutant in the run does it
//   CM_TAMPER_PATH    repo-relative path to write, resolved against cwd (the
//                     workspace this command was started in)
//   CM_TAMPER_CONTENT file holding the bytes to write, for 'revert'
//   CM_TAMPER_GUARD   repo-relative path that must currently contain 'MUTATED_'
//                     before anything is written. This is what distinguishes a
//                     MUTANT run from the unmutated narrow-baseline run of the
//                     same command in phase A -- tampering during phase A would
//                     poison the ledger's idea of the original bytes and the test
//                     would silently stop testing anything.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const scope = process.argv[2] ?? '';
const mode = process.env.CM_TAMPER_MODE;
const target = process.env.CM_TAMPER_PATH;

function guardIsMutated() {
  if (!process.env.CM_TAMPER_GUARD) return true;
  try {
    return readFileSync(path.resolve(process.cwd(), process.env.CM_TAMPER_GUARD), 'utf8').includes('MUTATED_');
  } catch {
    return false;
  }
}

if (mode && target && scope === process.env.CM_TAMPER_SCOPE && guardIsMutated()) {
  const abs = path.resolve(process.cwd(), target);
  if (mode === 'revert') {
    writeFileSync(abs, readFileSync(process.env.CM_TAMPER_CONTENT));
  } else if (mode === 'contaminate') {
    writeFileSync(abs, "export function value() {\n  return 'FOREIGN_RESIDUE';\n}\n");
  }
}

process.stdout.write([
  '✔ fake tampering probe (0.1ms)',
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
