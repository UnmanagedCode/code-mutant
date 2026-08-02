// The five verdicts, with uniform semantics across every stack.
//
// Classification lives in shared code because hand-rolled parsing of test output
// demonstrably got it wrong in real sessions ("my grep didn't match node's output
// format"), and because a non-zero exit code is something a conductor can gate on
// where a self-reported verdict is not.
//
// Pure: no filesystem, no subprocess, no clock. Everything it needs arrives as
// arguments, so every branch is directly testable.

import { normalizePath } from './adapters/common.mjs';

export const Verdict = {
  KILLED: 'KILLED',
  SURVIVED: 'SURVIVED',
  IMPRECISE: 'IMPRECISE',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',
};

export const Reason = {
  COMPILE_ERROR: 'compile-error',
  EXPECT_PASS_BROKE: 'expect-pass-broke',
  EXTRA_FAILURES: 'extra-failures',
  PARTIAL_KILL: 'partial-kill',
  SCOPE_EMPTY: 'scope-empty',
  SCOPE_NON_GREEN: 'scope-non-green',
  UNEXPLAINED_EXIT: 'unexplained-exit',
  TIMED_OUT: 'timed-out',
  COMMAND_FAILED_TO_START: 'command-failed-to-start',
  OUTPUT_TRUNCATED: 'output-truncated',
};

// Comparison is on exact ids, with only cosmetic normalisation applied to both
// sides. A file-only reference therefore matches only a file-level failure (a
// module that failed to load), never "any failure in this file" -- treating it as
// a wildcard would quietly weaken what KILLED means.
export function normalizeRef(ref) {
  const text = String(ref).trim();
  const at = text.indexOf('::');
  if (at === -1) return normalizePath(text);
  return `${normalizePath(text.slice(0, at))}::${text.slice(at + 2).trim()}`;
}

function toSet(refs) {
  return new Set((refs ?? []).map(normalizeRef));
}

export function classify({ run, parsed, expectFail = [], expectPass = [] }) {
  const grade = parsed?.grade ?? 'counted';
  const base = { grade, failed: [], unexpectedFailures: [], missingFailures: [] };

  if (run.spawnError) {
    return {
      ...base,
      verdict: Verdict.ERROR,
      reason: Reason.COMMAND_FAILED_TO_START,
      detail: `the command could not be started: ${run.spawnError}`,
    };
  }

  if (run.timedOut) {
    return {
      ...base,
      verdict: Verdict.TIMEOUT,
      reason: Reason.TIMED_OUT,
      detail: `the command was killed after ${Math.round(run.durationMs)}ms -- the mutation may have hung the suite`,
    };
  }

  // A truncated capture can silently drop the failure-name block or the summary
  // banner itself -- either turns a real KILLED into a false SURVIVED/ERROR with
  // no visible sign. Checked before the grade split: even exit-code grade, whose
  // verdict does not depend on parsed text, gets no exception, because a reader
  // of the report should never have to know which grade tolerates truncation.
  if (run.truncated) {
    return {
      ...base,
      verdict: Verdict.ERROR,
      reason: Reason.OUTPUT_TRUNCATED,
      detail: 'the command\'s captured output exceeded the capture limit and was truncated -- failure '
        + 'names and/or the summary banner may be missing, so no verdict can be trusted',
    };
  }

  // Exit-code grade: kill/no-kill only. IMPRECISE is not detectable here, and
  // pretending otherwise is exactly the error the grade label exists to prevent.
  if (grade === 'exit-code') {
    return run.exitCode === 0
      ? {
        ...base,
        verdict: Verdict.SURVIVED,
        reason: null,
        detail: 'the gate command still exited 0 with the mutation applied',
      }
      : {
        ...base,
        verdict: Verdict.KILLED,
        reason: null,
        detail: `the gate command exited ${run.exitCode}; precision was NOT established (exit-code grade)`,
      };
  }

  if (parsed.compileError) {
    return {
      ...base,
      verdict: Verdict.IMPRECISE,
      reason: Reason.COMPILE_ERROR,
      detail: 'the mutation broke the build or module load rather than a test -- rewrite it smaller',
    };
  }

  if (parsed.ran === 0) {
    return {
      ...base,
      verdict: Verdict.ERROR,
      reason: Reason.SCOPE_EMPTY,
      detail: 'the narrowed command ran zero tests, so no verdict is possible (it must not read SURVIVED)',
    };
  }

  const failedIds = parsed.failedTests.map((t) => normalizeRef(t.id));
  const failedSet = new Set(failedIds);
  const failSet = toSet(expectFail);
  const passSet = toSet(expectPass);

  const brokePass = [...passSet].filter((id) => failedSet.has(id));
  if (brokePass.length) {
    return {
      ...base,
      failed: failedIds,
      unexpectedFailures: brokePass,
      verdict: Verdict.IMPRECISE,
      reason: Reason.EXPECT_PASS_BROKE,
      detail: `the mutation also broke ${brokePass.join(', ')}, which was expected to keep passing`,
    };
  }

  const extra = failedIds.filter((id) => !failSet.has(id));
  const missing = [...failSet].filter((id) => !failedSet.has(id));

  // A counted runner that exits non-zero while naming no failing test is
  // reporting something the adapter cannot see -- a crash after the summary
  // banner, a concurrency guardrail tripping, a post-suite hook. Whether the
  // mutation was killed is simply unknown, so this is ERROR (no verdict) rather
  // than IMPRECISE ("rewrite the mutant smaller", which would be wrong advice and
  // would let a catalog of these exit 0 CLEAN). Reading it as SURVIVED would
  // publish a false finding -- the one direction this tool must never get wrong.
  //
  // Placed below the scope-empty check so a zero-test scope keeps its more
  // specific reason, and below the exit-code-grade return so that grade, whose
  // whole verdict IS the exit code, is untouched.
  if (failedIds.length === 0 && run.exitCode !== 0) {
    return {
      ...base,
      verdict: Verdict.ERROR,
      reason: Reason.UNEXPLAINED_EXIT,
      detail: `the command exited ${run.exitCode} but named no failing test, so it is not observably `
        + 'green and no verdict is possible (it must not read SURVIVED)',
    };
  }

  if (failedIds.length === 0) {
    return {
      ...base,
      verdict: Verdict.SURVIVED,
      reason: null,
      missingFailures: missing,
      detail: missing.length
        ? `the suite stayed green: ${missing.join(', ')} passes either way, so the coverage claim is false`
        : 'the suite stayed green with the mutation applied, so the coverage claim is false',
    };
  }

  if (extra.length) {
    return {
      ...base,
      failed: failedIds,
      unexpectedFailures: extra,
      missingFailures: missing,
      verdict: Verdict.IMPRECISE,
      reason: Reason.EXTRA_FAILURES,
      detail: `failures outside expectFail: ${extra.join(', ')} -- the mutant is too broad, rewrite it smaller`,
    };
  }

  if (missing.length) {
    return {
      ...base,
      failed: failedIds,
      missingFailures: missing,
      verdict: Verdict.IMPRECISE,
      reason: Reason.PARTIAL_KILL,
      detail: `only part of expectFail failed; still passing: ${missing.join(', ')}`,
    };
  }

  return {
    ...base,
    failed: failedIds,
    verdict: Verdict.KILLED,
    reason: null,
    detail: `exactly the expected tests failed (${failedIds.join(', ')}) and every expectPass test still passed`,
  };
}
