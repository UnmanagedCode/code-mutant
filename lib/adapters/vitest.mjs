// `vitest run --reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"`.
// Pinned to captured reports in test/fixtures/vitest/ -- see PROVENANCE.md there.
//
// JSON ONLY, read from the report FILE the runner hands back as
// `context.reports['vitest.json']` (lib/reports.mjs). Neither stdout nor the
// text reporter is parsed: a command that writes no report reads ZERO tests plus
// a `diagnostic` naming the flags, so its baseline fails loudly instead of being
// half-read. Writing the report to a file is also what keeps Vitest from its
// default `<root>/.vitest/json/output.json`, which would be residue in an
// in-place tree.
//
// FAIL CLOSED: a report that does not parse, or whose statuses and counters do
// not reconcile, is treated as unreadable -- `ran: 0` plus a diagnostic, which is
// never green and never a verdict. Damage can therefore cost a verdict, never
// fabricate one.
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

// The basename the adapter reads from the report dir, and the flags that put it
// there -- the one place either is spelled.
export const REPORT_FILE = 'vitest.json';
export const REQUIRED_FLAGS = `--reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/${REPORT_FILE}"`;
// Read by validate: this adapter sees nothing unless its command names the dir.
export const readsReportDir = true;

const FILE_STATUSES = new Set(['passed', 'failed']);
const ASSERTION_STATUSES = new Set(['passed', 'failed', 'skipped', 'pending', 'todo']);

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
  const text = context.reports?.[REPORT_FILE];
  if (typeof text !== 'string') {
    return unreadable(exitCode, `no Vitest JSON report (${REPORT_FILE}) in the report dir: the command must pass ${REQUIRED_FLAGS}`);
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch (err) {
    return unreadable(exitCode, `the Vitest JSON report is unreadable: ${err.message}`);
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return unreadable(exitCode, 'the Vitest JSON report is unreadable: it has no testResults array');
  }
  const problem = integrityProblem(report);
  if (problem) return unreadable(exitCode, `the Vitest JSON report is unreadable: ${problem}`);

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
