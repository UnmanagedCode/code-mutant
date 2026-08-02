// The degraded signal grade, for gates with no pass/fail/skip counts to parse at
// all: `npx tsc --noEmit`, `npm run snap`, a Playwright gate.
//
// KILLED vs SURVIVED still work off 0/non-zero. IMPRECISE detection does NOT --
// there is no way to tell "the right test failed" from "something else broke", so
// this adapter reports no counts and no failed-test names, and every verdict it
// produces is labelled with this grade in the report. Presenting an exit-code
// kill as if precision had been established is the specific error the labelling
// exists to prevent.
//
// Narrowing is a no-op here: there are no named tests to filter, so the whole
// gate command runs. A per-mutant `narrowCommand` is how an exit-code gate gets
// scoped down.

export const name = 'exit-code';
export const grade = 'exit-code';
export const canNameFilter = false;
// There are no named tests at this grade, so a reference names nothing at all.
export const refsNameFiles = false;
export const testFilePatterns = [];

export function parse(stdout, stderr, exitCode) {
  return {
    grade: 'exit-code',
    passed: null,
    failed: null,
    skipped: null,
    ran: null,
    failedTests: [],
    // Never inferred: a compile break and a failing gate are indistinguishable
    // from an exit code, and guessing would fabricate precision.
    compileError: false,
    counts: { exitCode },
  };
}

export function scopeOf(ref) {
  return String(ref);
}

export function substitute() {
  return '';
}

// No named tests exist to append one to. gates.mjs synthesises this grade's
// canary by injecting an unparseable line into the mutant's own site file.
export function canary() {
  return null;
}
