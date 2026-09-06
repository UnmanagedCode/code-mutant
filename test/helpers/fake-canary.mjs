// EVERY FAKE TEST COMMAND MUST BE ABLE TO OBSERVE A DELIBERATE BREAK.
//
// The canary gate now runs the command that JUDGES each mutant -- its narrow
// scope -- and not only `baselineCommand`. A fake that reports green
// unconditionally is therefore refused, correctly: nothing it says about a
// mutant could mean anything. So each fake in this directory answers the
// synthesised canary from the bytes of the file it was injected into, and
// nothing else about that fake changes.
//
// Content-addressed, for the same reason staged-command.mjs's block condition is:
// a fake must not have to know WHICH invocation the gate is. The gate's
// invocation count varies with the catalog, and an ordinal that shifted would
// make a fixture answer the wrong command.
//
// It also deliberately does not touch any fake's own invocation counter: a
// fixture that sequences behaviour by ordinal (CM_FAKE_BLOCK_ON) sequences the
// same commands it did before this gate existed.

import { readFileSync } from 'node:fs';

// The call the shipped `canary(source, {file})` implementations append. Matched
// on the injected CALL rather than on the label alone, so a test file that merely
// mentions the label in prose is not mistaken for an injected canary.
const CANARY_CALL = /__codeMutantCanary\(\s*["']([^"']+)["']/;

// The first argv-named file carrying an injected canary, or null. Paths are
// resolved against cwd, which is the workspace the measured command was started
// in -- the same basis every other fake here reads the tree on.
export function findCanary(argv = process.argv.slice(2)) {
  for (const arg of argv) {
    let source;
    try {
      source = readFileSync(arg, 'utf8');
    } catch {
      continue; // a flag, or a path outside this workspace
    }
    const match = source.match(CANARY_CALL);
    if (match) return { file: arg, label: match[1] };
  }
  return null;
}

// `node --test` spec-reporter shaped, with the inline block, the counters and the
// `failing tests:` marker paired with a `test at <file>` line -- that pairing is
// what gives the failure its file::name id, which is what `matches()` checks.
export function reportCanary({ file, label }) {
  process.stdout.write([
    `✖ ${label} (0.1ms)`,
    'ℹ tests 1',
    'ℹ suites 0',
    'ℹ pass 0',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 1',
    '✖ failing tests:',
    '',
    `test at ${file}:1:1`,
    `✖ ${label} (0.1ms)`,
    '',
  ].join('\n'));
}

// Returns true when this invocation WAS the canary and has been answered; the
// caller must then exit non-zero and do nothing else.
export function answerCanary(argv = process.argv.slice(2)) {
  const found = findCanary(argv);
  if (!found) return false;
  reportCanary(found);
  return true;
}
