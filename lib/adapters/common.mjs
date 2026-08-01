// Helpers shared by the shipped output adapters.
//
// Every adapter exports the same surface, and `parse(stdout, stderr, exitCode)`
// is fixed by the project-local `custom` escape hatch's contract -- a project
// parser is a drop-in for a shipped one, so shipped ones may not take extra
// arguments either.

export const CANARY_LABEL = 'code_mutant_canary';
export const CANARY_MESSAGE = 'code-mutant canary';

// A line no language parses. Used only by the exit-code canary, where there are
// no named tests to append one to.
export const CANARY_INVALID_LINE = '@@code-mutant-canary-must-not-parse@@';

// Strips CSI escape sequences. Written with an explicit \u001b escape rather
// than a literal control byte in the source, and deliberately anchored on that
// escape: a looser pattern would eat real bracketed output (vitest prints
// `FAIL f.js [ f.js ]`).
export function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A test reference is `<file>` or `<file>::<name>` for the file-based adapters.
// dotnet overrides this, because its output carries no file at all.
export function splitRef(ref) {
  const text = String(ref);
  const at = text.indexOf('::');
  if (at === -1) return { file: normalizePath(text), name: null };
  return { file: normalizePath(text.slice(0, at)), name: text.slice(at + 2) };
}

export function normalizePath(value) {
  return String(value).replace(/^\.\//, '').replace(/\/{2,}/g, '/').trim();
}

export function makeId(file, name) {
  return name ? `${normalizePath(file)}::${name}` : normalizePath(file);
}

// Every counted adapter returns this shape. `ran` is the number of tests the
// command actually reported, and it is load-bearing: a scope that runs zero
// tests must fail as ERROR, never read SURVIVED.
export function countedResult({
  passed = 0, failed = 0, skipped = 0, ran = 0, failedTests = [], compileError = false, counts = {},
}) {
  return { grade: 'counted', passed, failed, skipped, ran, failedTests, compileError, counts };
}

export function lastMatch(text, regex) {
  const matches = [...text.matchAll(regex)];
  return matches.length ? matches[matches.length - 1] : null;
}
