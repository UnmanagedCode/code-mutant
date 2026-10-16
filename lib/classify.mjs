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
  LEARNED: 'LEARNED',
};

export const Reason = {
  COMPILE_ERROR: 'compile-error',
  EXPECT_PASS_BROKE: 'expect-pass-broke',
  EXTRA_FAILURES: 'extra-failures',
  PARTIAL_KILL: 'partial-kill',
  SCOPE_EMPTY: 'scope-empty',
  SCOPE_NON_GREEN: 'scope-non-green',
  // Distinct from SCOPE_NON_GREEN because the BLAME is different and it is the
  // most useful thing the report can say: the unmutated scope hung on its own, so
  // this is a project defect to route upward, not a mutant to rewrite. A mutation
  // that was never measured cannot be blamed for anything.
  SCOPE_TIMED_OUT: 'scope-timed-out',
  UNEXPLAINED_EXIT: 'unexplained-exit',
  TIMED_OUT: 'timed-out',
  COMMAND_FAILED_TO_START: 'command-failed-to-start',
  OUTPUT_TRUNCATED: 'output-truncated',
  OUTPUT_INCOMPLETE: 'output-incomplete',
  // The three isolation-integrity reasons. Every one of them is an ERROR, never a
  // downgraded verdict: they say the tree the measurement ran against was not the
  // tree the measurement claims, and a run whose isolation is in doubt supports no
  // verdict in EITHER direction -- the same race that produced a false SURVIVED
  // produces a false KILLED just as easily, and silently. See lib/occupancy.mjs.
  WORKSPACE_OCCUPIED: 'workspace-occupied',
  WORKSPACE_RESIDUE: 'workspace-residue',
  MUTATION_NOT_INTACT: 'mutation-not-intact',
};

// WHICH VERDICTS ARE A GRADE, and which are the absence of one. This is the
// authoritative split: `graded` on a result is derived from the verdict and
// nothing else, so the two can never disagree.
export const GRADED_VERDICTS = new Set([
  Verdict.KILLED, Verdict.SURVIVED, Verdict.IMPRECISE, Verdict.LEARNED,
]);

export function isGraded(verdict) {
  return GRADED_VERDICTS.has(verdict);
}

// The same split over REASONS, which exists for one structural purpose: a new
// reason cannot be added without deciding which side it falls on, because
// test/ungraded-shape.test.mjs asserts the partition is total over
// Object.values(Reason) and disjoint. Adding a reason and forgetting to classify
// it fails that test rather than silently landing an ungraded result that looks
// graded -- which is precisely the 2026-0183 phantom-regression shape.
//
// The four graded reasons are all IMPRECISE: a verdict WAS reached, and it says
// the mutant is invalid. Everything else means no verdict was possible.
export const GRADED_REASONS = new Set([
  Reason.COMPILE_ERROR,
  Reason.EXPECT_PASS_BROKE,
  Reason.EXTRA_FAILURES,
  Reason.PARTIAL_KILL,
]);

export const UNGRADED_REASONS = new Set([
  Reason.SCOPE_EMPTY,
  Reason.SCOPE_NON_GREEN,
  Reason.SCOPE_TIMED_OUT,
  Reason.UNEXPLAINED_EXIT,
  Reason.TIMED_OUT,
  Reason.COMMAND_FAILED_TO_START,
  Reason.OUTPUT_TRUNCATED,
  Reason.OUTPUT_INCOMPLETE,
  Reason.WORKSPACE_OCCUPIED,
  Reason.WORKSPACE_RESIDUE,
  Reason.MUTATION_NOT_INTACT,
]);

// The reasons built at runtime rather than named in `Reason`: the hook phases
// (`setup-hook-failed` / `teardown-hook-failed`), the lazily-established
// per-mutant canary, a site that would not resolve (SiteError codes -- see
// lib/sites.mjs), and the runner's catch-all. Every one is an ERROR, so every one
// is ungraded; listed here so the set is a complete answer rather than a partial
// one a caller has to supplement.
export const DYNAMIC_UNGRADED_REASONS = new Set([
  'setup-hook-failed',
  'teardown-hook-failed',
  'canary-not-established',
  'plan-failed',
]);

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

export function classify({ run, parsed, expectFail = [], expectPass = [], learn = false }) {
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

  // The sibling of the truncation check above, and here for the same reason: the
  // command exited but its streams were still open when the drain grace expired,
  // so something else was holding them and the capture may be short. Also checked
  // BEFORE the grade split -- settling early must never be able to turn an
  // under-captured run into a SURVIVED, which is the one direction this tool must
  // never get wrong.
  if (run.outputIncomplete) {
    return {
      ...base,
      verdict: Verdict.ERROR,
      reason: Reason.OUTPUT_INCOMPLETE,
      detail: 'the command exited but its output streams were still open when the drain grace expired, '
        + 'so the captured output may be incomplete and no verdict can be trusted',
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
      detail: 'the narrowed command ran zero tests, so no verdict is possible (it must not read SURVIVED)'
        + `${parsed.diagnostic ? ` -- ${parsed.diagnostic}` : ''}`,
    };
  }

  const failedIds = parsed.failedTests.map((t) => normalizeRef(t.id));
  const failedSet = new Set(failedIds);
  const failSet = toSet(expectFail);
  const passSet = toSet(expectPass);

  const brokePass = [...passSet].filter((id) => failedSet.has(id));
  if (!learn && brokePass.length) {
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
      detail: learn
        ? 'nothing failed with the mutation applied, so no test in this scope covers it (learn mode: nothing was claimed)'
        : (missing.length
          ? `the suite stayed green: ${missing.join(', ')} passes either way, so the coverage claim is false`
          : 'the suite stayed green with the mutation applied, so the coverage claim is false'),
    };
  }

  if (learn) {
    return {
      ...base,
      failed: failedIds,
      verdict: Verdict.LEARNED,
      reason: null,
      detail: `${failedIds.length} test(s) failed with the mutation applied; nothing was graded `
        + `(learn mode -- these are the refs to put in expectFail): ${failedIds.join(', ')}`,
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
