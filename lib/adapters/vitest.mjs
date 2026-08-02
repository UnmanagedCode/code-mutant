// `vitest run` default reporter. Pinned to captured output in test/fixtures/vitest/.
//
// Counts come from stdout's `      Tests  2 failed | 1 passed (3)` line, whose
// trailing `(N)` is the total. Failed test names come from STDERR, which is where
// vitest writes its `FAIL  <file> > <name>` blocks -- nested tests appear as
// `FAIL  f.js > outer > inner`, so a reviewer's expectFail entry carries the full
// `outer > inner` path. A file that fails to transform shows up under
// `Failed Suites` with `Tests  no tests`; that is the compile-error signal.

import {
  CANARY_LABEL, CANARY_MESSAGE, countedResult, escapeRegExp, lastMatch, makeId, normalizePath,
  shellQuote, splitRef, stripAnsi,
} from './common.mjs';

export const name = 'vitest';
export const grade = 'counted';
export const canNameFilter = true;
export const refsNameFiles = true;
export const testFilePatterns = ['**/*.test.js', '**/*.test.ts', '**/*.spec.js', '**/*.spec.ts'];

export function parse(stdout, stderr, exitCode) {
  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);

  const line = lastMatch(out, /^\s*Tests\s+(.+)$/gm);
  const summary = line ? line[1] : '';
  const counts = {};
  for (const [, value, label] of summary.matchAll(/(\d+)\s+(failed|passed|skipped|todo)/g)) {
    counts[label] = Number(value);
  }
  const totalMatch = summary.match(/\((\d+)\)\s*$/);
  const noTests = /\bno tests\b/.test(summary);

  const passed = counts.passed ?? 0;
  const failed = counts.failed ?? 0;
  const skipped = (counts.skipped ?? 0) + (counts.todo ?? 0);
  const ran = noTests ? 0 : (totalMatch ? Number(totalMatch[1]) : passed + failed + skipped);

  const failedTests = [];
  for (const [, file, testName] of err.matchAll(/^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/gm)) {
    const normalized = normalizePath(file);
    failedTests.push({ file: normalized, name: testName, id: makeId(normalized, testName) });
  }

  // ` FAIL  f.js [ f.js ]` under "Failed Suites" -- the file never produced tests.
  const failedSuites = [...err.matchAll(/^\s*FAIL\s+(\S+)\s+\[/gm)].map((m) => normalizePath(m[1]));
  const compileError = failedSuites.length > 0 || (noTests && /Test Files\s+\d+ failed/.test(out));

  return countedResult({
    passed, failed, skipped, ran, failedTests, compileError,
    counts: { ...counts, failedSuites, exitCode },
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
  // -t is a substring/regex match against the full nested name path.
  return `${files} -t ${shellQuote(names.map(escapeRegExp).join('|'))}`;
}

export function canary(source, { file }) {
  const label = `${CANARY_LABEL}_fires`;
  const content = `${source}${source.endsWith('\n') ? '' : '\n'}
import { test as __codeMutantCanary } from 'vitest';
__codeMutantCanary(${JSON.stringify(label)}, () => { throw new Error(${JSON.stringify(CANARY_MESSAGE)}); });
`;
  return {
    content,
    testId: makeId(file, label),
    matches: (failure) => failure.name === label || failure.name.endsWith(`> ${label}`),
  };
}
