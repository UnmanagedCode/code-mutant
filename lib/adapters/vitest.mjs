// `vitest run --reporter=json --outputFile=/dev/stdout`. Pinned to captured
// output in test/fixtures/vitest/ -- see PROVENANCE.md there.
//
// JSON ONLY. The text reporter is not parsed: a command without the JSON flags
// reports ZERO tests plus a `diagnostic` naming them, so its baseline fails
// loudly instead of being half-read.
//
// The channel, as Vitest 5 writes it: the report is one `JSON.stringify` line
// with no trailing newline, written at run end, then followed on stdout by
// `JSON report written to /dev/stdout`. Without `outputFile` Vitest writes to
// `<root>/.vitest/json/output.json` instead -- residue in an in-place tree -- so
// the flag is part of the contract. Test output can only reach stdout through
// Vitest's main process: the JSON reporter drops `console.*` from tests, and a
// raw `process.stdout.write` lands BEFORE the report. So the report is found by
// its fixed opening key, scanning candidates from the LAST one back, which skips
// both leading noise and a decoy marker a test printed.
//
// FAIL CLOSED: a report whose statuses or counters do not reconcile is treated
// as unreadable -- `ran: 0` plus a diagnostic, which is never green and never a
// verdict. Corruption can therefore cost a verdict, never fabricate one.
//
// Test identity: `testResults[].name` is an ABSOLUTE path, relativised against
// the workspace the command ran in (`context.cwd`); the test name is
// `[...ancestorTitles, title].join(' > ')`. Vitest's own `fullName` joins with a
// space and is not used.
//
// `-t` is matched against Vitest's `fullTestName`, which Vitest 5 joins with
// ' > ' (createTaskName in vitest/dist/task-utils.js) -- the same path a
// reference names -- so names mode passes each name through verbatim, anchored.
// Measured against Vitest 5.0.5: `-t '^nested > deeper > inner failure$'` runs
// exactly that nested test; the space-joined form selects nothing.

import { realpathSync } from 'node:fs';
import path from 'node:path';

import {
  CANARY_LABEL, CANARY_MESSAGE, countedResult, escapeRegExp, makeId, normalizePath,
  shellQuote, splitRef,
} from './common.mjs';

export const name = 'vitest';
export const grade = 'counted';
export const canNameFilter = true;
export const refsNameFiles = true;
export const testFilePatterns = [
  '**/*.test.js', '**/*.test.ts', '**/*.test.jsx', '**/*.test.tsx',
  '**/*.spec.js', '**/*.spec.ts', '**/*.spec.jsx', '**/*.spec.tsx',
];

export const REQUIRED_FLAGS = '--reporter=json --outputFile=/dev/stdout';

const REPORT_MARKER = '{"numTotalTestSuites":';
const FILE_STATUSES = new Set(['passed', 'failed']);
const ASSERTION_STATUSES = new Set(['passed', 'failed', 'skipped', 'pending', 'todo']);

// The index of the `}` closing the object opened at `start`, or -1. String-aware,
// so a brace inside a test title or failure message never closes it early.
function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The report object, or null when stdout carries none. Exported for the tests
// that pin extraction against noise, decoys and corruption.
export function extractReport(stdout) {
  const text = String(stdout ?? '');
  const starts = [];
  for (let at = text.indexOf(REPORT_MARKER); at !== -1; at = text.indexOf(REPORT_MARKER, at + 1)) {
    starts.push(at);
  }
  for (const start of starts.reverse()) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    let candidate;
    try {
      candidate = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (candidate && Array.isArray(candidate.testResults)) return candidate;
  }
  return null;
}

// Null when the report is self-consistent, else why it is not. Every check is
// one Vitest's own reporter satisfies by construction (JsonReporter derives the
// counters from the same tests it lists), so a mismatch means the bytes were
// damaged between Vitest and here.
function integrityProblem(report) {
  const tally = { total: 0, passed: 0, failed: 0 };
  for (const file of report.testResults) {
    if (!file || typeof file.name !== 'string' || !FILE_STATUSES.has(file.status)
      || !Array.isArray(file.assertionResults)) {
      return `a file entry has an unknown shape or status (${JSON.stringify(file?.status)})`;
    }
    for (const assertion of file.assertionResults) {
      if (!assertion || typeof assertion.title !== 'string' || !Array.isArray(assertion.ancestorTitles)
        || !ASSERTION_STATUSES.has(assertion.status)) {
        return `a test entry in ${file.name} has an unknown shape or status (${JSON.stringify(assertion?.status)})`;
      }
      tally.total += 1;
      if (assertion.status === 'passed') tally.passed += 1;
      if (assertion.status === 'failed') tally.failed += 1;
    }
  }
  const pairs = [
    ['numTotalTests', tally.total], ['numPassedTests', tally.passed], ['numFailedTests', tally.failed],
  ];
  for (const [field, counted] of pairs) {
    if (report[field] !== counted) return `${field} is ${JSON.stringify(report[field])} but the report lists ${counted}`;
  }
  return null;
}

function relativeTo(absolute, cwd) {
  if (!cwd || !path.isAbsolute(absolute)) return normalizePath(absolute);
  const roots = [cwd];
  try { roots.push(realpathSync(cwd)); } catch { /* the plain root is enough */ }
  for (const root of roots) {
    const rel = path.relative(root, absolute);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return normalizePath(rel.split(path.sep).join('/'));
  }
  return normalizePath(absolute);
}

function unreadable(exitCode, diagnostic) {
  return { ...countedResult({ counts: { exitCode } }), files: [], diagnostic };
}

export function parse(stdout, stderr, exitCode, context = {}) {
  const report = extractReport(stdout);
  if (!report) {
    return unreadable(exitCode, `no Vitest JSON report on stdout: the command must pass ${REQUIRED_FLAGS}`);
  }
  const problem = integrityProblem(report);
  if (problem) return unreadable(exitCode, `the Vitest JSON report on stdout is unreadable: ${problem}`);

  let passed = 0;
  let skipped = 0;
  let ran = 0;
  const failedTests = [];
  const loadFailures = [];
  const files = [];
  for (const entry of report.testResults) {
    const file = relativeTo(entry.name, context.cwd);
    files.push(file);
    // A file that never produced a test -- a transform/import failure, or no
    // suite at all -- is one failing, file-level test, named by the file alone.
    if (entry.status === 'failed' && entry.message && !entry.assertionResults.length) {
      loadFailures.push(file);
      failedTests.push({ file, name: file, id: makeId(file, null) });
      ran += 1;
      continue;
    }
    for (const assertion of entry.assertionResults) {
      ran += 1;
      if (assertion.status === 'passed') passed += 1;
      else if (assertion.status === 'failed') {
        const testName = [...assertion.ancestorTitles, assertion.title].join(' > ');
        failedTests.push({ file, name: testName, id: makeId(file, testName) });
      } else skipped += 1;
    }
  }

  return {
    ...countedResult({
      passed,
      failed: failedTests.length,
      skipped,
      ran,
      failedTests,
      compileError: loadFailures.length > 0,
      counts: { todo: report.numTodoTests, loadFailures, exitCode },
    }),
    files,
    diagnostic: null,
  };
}

export function scopeOf(ref) {
  return splitRef(ref).file;
}

export function substitute({ scopes, refs, mode }) {
  const files = scopes.map(shellQuote).join(' ');
  if (mode !== 'names') return files;
  const names = refs.map((r) => splitRef(r).name).filter(Boolean);
  if (!names.length) return files;
  return `${files} -t ${shellQuote(`^(?:${names.map(escapeRegExp).join('|')})$`)}`;
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
