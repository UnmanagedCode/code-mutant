// `pytest` default reporter. Pinned to captured output in test/fixtures/pytest/.
//
// Counts come from the final banner: `===== 2 failed, 1 passed in 0.01s =====`.
// Failed ids come from the `short test summary info` block, which prints real
// pytest nodeids (`tests/test_math.py::TestGroup::test_inner`) -- so a reviewer's
// expectFail entry is literally a nodeid, the identifier pytest users already use.
// A collection failure prints `ERROR <file>` plus `Interrupted: 1 error during
// collection` and collects 0 items; that is the compile-error signal.

import {
  CANARY_LABEL, CANARY_MESSAGE, countedResult, lastMatch, makeId, normalizePath, shellQuote,
  splitRef, stripAnsi,
} from './common.mjs';

export const name = 'pytest';
export const grade = 'counted';
export const canNameFilter = true;
export const testFilePatterns = ['**/test_*.py', '**/*_test.py'];

export function parse(stdout, stderr, exitCode) {
  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);

  const banner = lastMatch(out, /^=+ (.*?) =+$/gm);
  const counts = {};
  if (banner) {
    for (const [, value, label] of banner[1].matchAll(/(\d+)\s+(\w+)/g)) {
      counts[label] = Number(value);
    }
  }

  const passed = counts.passed ?? 0;
  const failed = (counts.failed ?? 0) + (counts.error ?? 0) + (counts.errors ?? 0);
  const skipped = counts.skipped ?? 0;
  const xfailed = counts.xfailed ?? 0;
  const xpassed = counts.xpassed ?? 0;

  const collectionError = /Interrupted:\s+\d+\s+errors?\s+during collection/.test(out)
    || /^=+ ERRORS =+$/m.test(out);
  // A collection error means zero tests ran, even though the banner's `error`
  // count would otherwise sum into `ran` as though something had.
  const ran = collectionError ? 0 : passed + failed + skipped + xfailed + xpassed;

  const failedTests = [];
  const summaryAt = out.indexOf('short test summary info');
  if (summaryAt !== -1) {
    for (const line of out.slice(summaryAt).split('\n')) {
      const match = line.match(/^(?:FAILED|ERROR)\s+(\S+)/);
      if (!match) continue;
      const { file, name: testName } = splitRef(match[1]);
      failedTests.push({ file, name: testName, id: makeId(file, testName) });
    }
  }

  const compileError = collectionError
    || ((counts.error ?? counts.errors ?? 0) > 0 && passed + (counts.failed ?? 0) === 0)
    || /^E\s+(SyntaxError|IndentationError):/m.test(`${out}\n${err}`);

  return countedResult({
    passed, failed, skipped, ran, failedTests, compileError,
    counts: { ...counts, exitCode },
  });
}

export function scopeOf(ref) {
  return splitRef(ref).file;
}

export function substitute({ scopes, refs, mode }) {
  if (mode !== 'names') return scopes.map(shellQuote).join(' ');
  // pytest narrows by nodeid natively, so the refs themselves are the argument.
  return refs.map(shellQuote).join(' ');
}

export function canary(source, { file }) {
  const label = `test_${CANARY_LABEL}_fires`;
  const content = `${source}${source.endsWith('\n') ? '' : '\n'}

def ${label}():
    raise AssertionError(${JSON.stringify(CANARY_MESSAGE)})
`;
  return {
    content,
    testId: makeId(normalizePath(file), label),
    matches: (failure) => failure.name === label,
  };
}
