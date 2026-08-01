// `node --test` (spec reporter). Pinned to captured output in
// test/fixtures/node-test/ -- see PROVENANCE.md there.
//
// Summary block:  ℹ tests 3 / ℹ pass 1 / ℹ fail 2 / ℹ skipped 0 / ℹ todo 0
// Failure block:  "✖ failing tests:" then, per failure, a `test at <file>:<l>:<c>`
//                 line followed by `✖ <name> (<duration>ms)`. Only that block is
//                 parsed: the spec reporter also prints each ✖ inline as it runs,
//                 so scanning the whole stream would double-count.
// A file that fails to load shows up as one failing "test" whose NAME IS THE FILE
// PATH, with body 'test failed' -- that identity is the compile-error signal.

import {
  CANARY_LABEL, CANARY_MESSAGE, countedResult, escapeRegExp, lastMatch, makeId, normalizePath,
  shellQuote, splitRef, stripAnsi,
} from './common.mjs';

export const name = 'node-test';
export const grade = 'counted';
export const canNameFilter = true;
export const testFilePatterns = ['**/*.test.mjs', '**/*.test.js', '**/*.test.cjs', '**/test/**/*.mjs'];

function counter(text, label) {
  const match = lastMatch(text, new RegExp(`^\\s*(?:ℹ|i)\\s+${label}\\s+(\\d+)\\s*$`, 'gm'));
  return match ? Number(match[1]) : 0;
}

export function parse(stdout, stderr, exitCode) {
  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);
  const all = `${out}\n${err}`;

  const passed = counter(out, 'pass');
  const failed = counter(out, 'fail');
  const skipped = counter(out, 'skipped');
  const todo = counter(out, 'todo');
  const ran = counter(out, 'tests');

  const failedTests = [];
  const marker = out.indexOf('failing tests:');
  if (marker !== -1) {
    let file = null;
    for (const line of out.slice(marker).split('\n')) {
      const at = line.match(/^test at (.+?):\d+:\d+\s*$/);
      if (at) { file = normalizePath(at[1]); continue; }
      const failure = line.match(/^✖ (.*) \([\d.]+ms\)\s*$/);
      if (failure && file) {
        failedTests.push({ file, name: failure[1], id: makeId(file, failure[1]) });
      }
    }
  }

  const moduleLevel = failedTests.some((t) => t.name === t.file);
  const compileError = moduleLevel
    || /^\s*(SyntaxError|ReferenceError):/m.test(all)
    || /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(all);

  return countedResult({
    passed, failed, skipped, ran, failedTests, compileError,
    counts: { todo, exitCode },
  });
}

export function scopeOf(ref) {
  return splitRef(ref).file;
}

export function substitute({ scopes, refs, mode }) {
  const files = scopes.map(shellQuote).join(' ');
  if (mode !== 'names') return files;
  const names = refs.map((r) => splitRef(r).name).filter(Boolean);
  if (!names.length) return files;
  const pattern = `^(?:${names.map(escapeRegExp).join('|')})$`;
  // The flag MUST precede the file positionals. node stops consuming its own
  // flags at the first positional, so `node --test file --test-name-pattern X`
  // silently passes the flag to the test file and filters nothing -- a false
  // KILLED waiting to happen.
  return `--test-name-pattern ${shellQuote(pattern)} ${files}`;
}

// Appends a named always-failing test to an existing, already-discovered test
// file, so the canary is guaranteed to be inside the command's scope. Module
// system is sniffed rather than assumed: an `import` in a CommonJS test file
// would produce a compile break, which fails the canary gate by design and would
// be a confusing way to learn the file was CJS.
export function canary(source, { file }) {
  const isCjs = /\.cjs$/.test(file) || (!/\.mjs$/.test(file) && /\brequire\s*\(/.test(source));
  const label = `${CANARY_LABEL}_fires`;
  const prelude = isCjs
    ? `const { test: __codeMutantCanary } = require('node:test');`
    : `import { test as __codeMutantCanary } from 'node:test';`;
  const content = `${source}${source.endsWith('\n') ? '' : '\n'}
${prelude}
__codeMutantCanary(${JSON.stringify(label)}, () => { throw new Error(${JSON.stringify(CANARY_MESSAGE)}); });
`;
  return {
    content,
    testId: makeId(file, label),
    matches: (failure) => failure.name === label,
  };
}
