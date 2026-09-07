// THE PRINTED COST BREAKDOWN, and the one note it is allowed to emit.
//
// Pure unit tests over hand-built report objects (mirrors learn-report.test.mjs
// and hang-report.test.mjs), so every number here is synthetic: these assert what
// the RENDERER concludes from a breakdown, never how long anything took. The
// wall-clock rule in CONVENTIONS is why the field measurements below are typed in
// as constants rather than reproduced.
//
// The failure this exists to prevent is a diagnostic that cries wolf. `timings`
// already carried the split, but only in --json, so an operator watching an hour
// of gate cost re-paid per invocation concluded "the suite is too slow" or "there
// are too many mutants" -- both of which lead to work that buys nothing. A note
// that also fires on the already-batched run would train that same operator to
// skip it, which is strictly worse than printing nothing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Verdict } from '../lib/classify.mjs';
import { GateOutcome } from '../lib/runner.mjs';
import { formatReport } from '../lib/report.mjs';
import { makeRepo } from './helpers/tmp-repo.mjs';
import { costConfig, costFiles, costMutants } from './helpers/cost-project.mjs';
import { runCli } from './helpers/cli.mjs';

// THE TWO RUNS THE PREDICATE MUST SEPARATE, from the epic plan's field data
// (prover session f99553e4, 35-mutant catalog, `npm test` ~67s). Same gates, same
// catalog, same project -- the ONLY difference is how many mutants rode along.
const FIELD_GATES_MS = 135_100;
const FIELD_NARROW_MS = 1_000;

// One mutant per invocation: 135_100 / (1_000 + 1_150) = 62.8x. The pathological
// case, and the one the operator has a move against.
const PER_MUTANT_INVOCATION = {
  timings: {
    totalMs: 137_250, gatesMs: FIELD_GATES_MS, narrowBaselinesMs: FIELD_NARROW_MS, mutantsMs: 1_150,
  },
  selection: { catalogTotal: 35, selected: 1 },
};

// All 35 in one invocation: 135_100 / (1_000 + 40_250) = 3.3x. Already optimal --
// the gates are still 75.7% of the run and there is NOTHING left to do about it.
const BATCHED_INVOCATION = {
  timings: {
    totalMs: 178_350, gatesMs: FIELD_GATES_MS, narrowBaselinesMs: FIELD_NARROW_MS, mutantsMs: 40_250,
  },
  selection: { catalogTotal: 35, selected: 35 },
};

function result(extra = {}) {
  return {
    id: 'm1',
    invariant: 'an invariant',
    whyNotEquivalent: 'not equivalent',
    waived: null,
    expectFail: ['test/a.test.mjs::one'],
    expectPass: [],
    verdict: Verdict.KILLED,
    reason: null,
    detail: 'a detail',
    grade: 'counted',
    reproducible: true,
    narrowing: {
      mode: 'file',
      command: "node --test 'test/a.test.mjs'",
      scopes: ['test/a.test.mjs'],
      requestedNames: false,
      downgradeReason: null,
      placeholder: true,
    },
    mutation: [{ kind: 'anchor', file: 'src/a.mjs', edits: [{ anchor: 'x', replacement: 'y', line: 1 }] }],
    failedTests: ['test/a.test.mjs::one'],
    unexpectedFailures: [],
    missingFailures: [],
    narrowBaseline: { command: "node --test 'test/a.test.mjs'", green: true, counts: { passed: 1, failed: 0, skipped: 0, ran: 1 } },
    mutantCounts: null,
    delta: null,
    canary: null,
    exitCode: 1,
    durationMs: 10,
    deadlineMs: null,
    hang: null,
    ...extra,
  };
}

// A measured (not served) pair of green gates, so the default report is one whose
// gate cost really was re-paid this invocation.
function measuredGates(extra = {}) {
  return {
    baseline: {
      outcome: GateOutcome.PASSED,
      command: 'node --test',
      counts: { passed: 2, failed: 0, skipped: 0, ran: 2 },
      exitCode: 0,
      failedTests: [],
      durationMs: 67_500,
      timedOut: false,
      detail: 'green',
      fromCache: false,
      measuredDurationMs: null,
    },
    // BASELINE scope, as in the field data: the epic's 135 100 ms is two WHOLE-SUITE
    // runs (baseline 67.5s + canary 67.6s). A canary's scope is what decides whether
    // its cost is fixed per invocation or scales with the mutants in the run, so a
    // fixture that gets it wrong cannot exercise the predicate honestly.
    canary: {
      outcome: GateOutcome.PASSED,
      status: 'KILLED',
      scope: 'baseline',
      grade: 'counted',
      command: 'node --test',
      target: 'test/a.test.mjs',
      attempts: [],
      scopes: null,
      durationMs: 67_600,
      detail: 'killed',
      fromCache: false,
      measuredDurationMs: null,
    },
    ...extra,
  };
}

// The other shape: one canary per DISTINCT narrowing command, whose cost therefore
// scales with the mutants in the run rather than being fixed against them.
function narrowCanary(durationMs = 67_600) {
  return {
    outcome: GateOutcome.PASSED,
    status: 'KILLED',
    scope: 'narrow',
    grade: 'counted',
    command: null,
    target: null,
    attempts: [],
    scopes: [{
      command: "node --test 'test/a.test.mjs'",
      target: 'test/a.test.mjs',
      status: 'KILLED',
      grade: 'counted',
      attempts: [],
      durationMs,
      detail: 'killed',
      mutants: ['m1'],
      skipped: null,
    }],
    durationMs,
    detail: 'killed',
    fromCache: false,
    measuredDurationMs: null,
  };
}

// GATES DERIVED FROM THE TIMINGS THEY SUM TO, unless the caller supplies their
// own. `timings.gatesMs` is `baseline.durationMs + canary.durationMs` on a real
// report (deriveTimings), and the predicate reads the gate records rather than the
// bucket -- so a fixture whose two halves disagree tests a report shape the runner
// cannot produce, and can pass or fail for reasons no real run would.
//
// Split as two whole-suite runs (baseline + baseline-scope canary), which is the
// field data's own shape and makes the whole of gatesMs fixed per invocation.
function baseReport(extra = {}) {
  const timings = extra.timings === undefined
    ? { totalMs: 100, gatesMs: 50, narrowBaselinesMs: 20, mutantsMs: 30 }
    : extra.timings;
  const gatesMs = Number.isFinite(timings?.gatesMs) ? timings.gatesMs : 0;
  const derived = measuredGates();
  return {
    command: 'run',
    isolation: 'in-place',
    jobs: 1,
    learn: false,
    workspaceRoot: '/tmp/x',
    adapter: { name: 'node-test', grade: 'counted', modulePath: null },
    gates: {
      baseline: { ...derived.baseline, durationMs: gatesMs / 2 },
      canary: { ...derived.canary, durationMs: gatesMs / 2 },
    },
    narrowBaselines: [],
    timings,
    selection: { catalogTotal: 4, selected: 4 },
    mutatedSha: 'abc123',
    reproducible: true,
    noTrace: null,
    results: [result()],
    ...extra,
  };
}

// The note's headline. Asserted as one constant so a reword cannot silently make
// half these tests vacuous.
const NOTE = /FIXED COST DOMINATES/;

describe('the printed cost breakdown', () => {
  test('C1: every bucket prints with its own share of totalMs', () => {
    // Criterion 1. The three numbers alone are what an operator has to be able to
    // read WITHOUT --json; the share is what makes 135100 legible as "98.5% of
    // this run" rather than a large number with no denominator.
    const text = formatReport(baseReport({
      timings: { totalMs: 1_000, gatesMs: 500, narrowBaselinesMs: 250, mutantsMs: 200 },
    }));

    assert.match(text, /Cost {2}\[totalMs 1000\]/);
    assert.match(text, /gatesMs\s+\|\s+500\s+\|\s+50\.0%/);
    assert.match(text, /narrowBaselinesMs\s+\|\s+250\s+\|\s+25\.0%/);
    assert.match(text, /mutantsMs\s+\|\s+200\s+\|\s+20\.0%/);
  });

  test('C2: gatesMs is labelled fixed-per-invocation where it is printed', () => {
    // The single misattribution this card exists to prevent. Docs do not reach
    // the reader at the moment they are staring at a big number.
    assert.match(formatReport(baseReport()), /gatesMs is FIXED per invocation/);
  });

  test('C3: totalMs of 0 renders every share as "-", never NaN or a fake 0.0%', () => {
    // A share of a zero total is undefined. `0.0%` would read as a real
    // measurement that happened to round down, and `NaN%` is garbage in the one
    // output a human reads when the run confused them.
    const text = formatReport(baseReport({
      timings: { totalMs: 0, gatesMs: 0, narrowBaselinesMs: 0, mutantsMs: 0 },
    }));

    assert.doesNotMatch(text, /NaN/);
    assert.doesNotMatch(text, /0\.0%/);
    assert.match(text, /gatesMs\s+\|\s+0\s+\|\s+-/);
    // Nothing ran, so there is no fixed per-invocation cost to characterise --
    // calling a zero bucket "FIXED per invocation" is a claim about a measurement
    // that never happened.
    assert.doesNotMatch(text, /FIXED per invocation/);
  });

  test('C4: an absent bucket renders "-" in both cells, never "undefined"', () => {
    // `deriveTimings` always supplies all four, but hand-built and older reports
    // do not -- and `undefined` printed into a table is how a renderer tells a
    // reader a number is zero when it is actually missing.
    const text = formatReport(baseReport({ timings: { totalMs: 500, gatesMs: 100 } }));

    assert.doesNotMatch(text, /undefined/);
    assert.match(text, /narrowBaselinesMs\s+\|\s+-\s+\|\s+-/);
    assert.match(text, /mutantsMs\s+\|\s+-\s+\|\s+-/);
  });

  test('C5: a report with no timings prints no Cost block and does not throw', () => {
    // learn-report.test.mjs's baseReport omits `timings` entirely, and so does any
    // report that never went through execute(). Throwing here would take out the
    // whole summary over a diagnostic that is the least important thing on it.
    const text = formatReport(baseReport({ timings: null }));

    assert.doesNotMatch(text, /Cost/);
    // The label line does not contain "Cost", so checking the heading alone would
    // pass an implementation that printed the annotations with no table.
    assert.doesNotMatch(text, /FIXED per invocation/);
    assert.match(text, /Trust gates/, 'the rest of the summary must still render');
  });

  test('C6: mutantsMs above totalMs prints a share over 100% and says why', () => {
    // Documented as legitimate: mutantsMs is a SUM of per-mutant wall clocks, so
    // under jobs > 1 it exceeds the wall clock it is a share of. Clamping to 100%
    // would be a lie, and printing 380% unexplained reads as a bug.
    const text = formatReport(baseReport({
      jobs: 4,
      timings: { totalMs: 1_000, gatesMs: 100, narrowBaselinesMs: 50, mutantsMs: 3_800 },
    }));

    assert.match(text, /mutantsMs\s+\|\s+3800\s+\|\s+380\.0%/);
    assert.match(text, /sum of per-mutant wall clocks/i);
    // The off-fixture: an unconditional line would make the explanation
    // meaningless, since it only explains a share that actually exceeds 100%.
    assert.doesNotMatch(formatReport(baseReport()), /sum of per-mutant wall clocks/i);
  });

  test('C6b: a report with no jobs key never prints "at jobs undefined"', () => {
    // The share-over-100% line names the concurrency that caused it. A report
    // carrying timings but no `jobs` must not print the word `undefined` into the
    // one output a human reads.
    const text = formatReport(baseReport({
      jobs: undefined,
      timings: { totalMs: 1_000, gatesMs: 100, narrowBaselinesMs: 50, mutantsMs: 3_800 },
    }));

    assert.doesNotMatch(text, /at jobs undefined/);
    assert.doesNotMatch(text, /correct reading at jobs/, 'no concurrency to attribute, so none is named');
    assert.match(text, /sum of per-mutant wall clocks/i, 'the explanation itself must survive');
  });
});

describe('the fixed-cost note fires on the pathological run and only on it', () => {
  test('C7: the field run -- 1 of 35 mutants at 62.8x -- fires the note and names --all', () => {
    // Criterion 2. The remedy has to be IN the message: two raw numbers leave the
    // reader to infer "batch harder", which is exactly the inference the field
    // operator did not make.
    const text = formatReport(baseReport(PER_MUTANT_INVOCATION));

    assert.match(text, NOTE);
    assert.match(text, /62\.8x/);
    assert.match(text, /carried 1 of 35 catalog mutant/);
    assert.match(text, /run --all/);
    // Nothing was served here, so neither cache line may appear: an unconditional
    // one would tell this operator their gates were free when they were not.
    assert.doesNotMatch(text, /served from the gate cache/);
    assert.doesNotMatch(text, /covers the canary only/);
  });

  test('C8: the same 35 mutants in ONE invocation at 3.3x stays silent', () => {
    // Rules out a share-of-totalMs predicate, and nothing more: the gates are
    // still 75.7% of this run, so a share threshold fires here even though the run
    // is already optimal. This fixture is DOUBLY silent (it fails the ratio
    // conjunct as well as the headroom one), so it does not discriminate the
    // headroom conjunct -- C15 owns that.
    const text = formatReport(baseReport(BATCHED_INVOCATION));

    assert.doesNotMatch(text, NOTE);
    assert.match(text, /gatesMs\s+\|\s+135100\s+\|\s+75\.7%/, 'the breakdown still prints');
  });

  test('C9: a subset run whose gates did NOT dominate stays silent', () => {
    // The note is about fixed-cost dominance, not about having selected a subset.
    // Firing on every --id run would make it noise on a cheap-gate project.
    const text = formatReport(baseReport({
      timings: { totalMs: 5_000, gatesMs: 2_000, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.doesNotMatch(text, NOTE);
  });

  test('C10: gates served from cache re-paid nothing, so no note -- and the block says so', () => {
    // gatesMs is 0 on a full hit because no command ran (serveGateRecord). Reading
    // that as "the gates were free" is right; reading it as a fixed cost this
    // invocation re-paid is exactly the misread the note must not make.
    const gates = measuredGates();
    const text = formatReport(baseReport({
      gates: {
        baseline: { ...gates.baseline, fromCache: true, measuredDurationMs: 67_500, durationMs: 0 },
        canary: { ...gates.canary, fromCache: true, measuredDurationMs: 67_600, durationMs: 0 },
      },
      timings: { totalMs: 2_200, gatesMs: 0, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.doesNotMatch(text, NOTE);
    assert.match(text, /served from the gate cache/);
    assert.match(text, /measuredDurationMs/, 'and points at where the original cost is');
    // The contradiction this pins: "gatesMs is FIXED per invocation" printed
    // directly above "gatesMs is 0 ... re-paid no fixed cost" tells the reader
    // both that there is a fixed cost here and that there is not.
    assert.doesNotMatch(text, /FIXED per invocation/);
  });

  test('C11: a half-hit with a NARROW canary says so, and stays silent under subset selection', () => {
    // The normal shape of a narrowing run: the baseline is served, a narrow canary
    // never is. SUBSET selection deliberately, so the silence below is the
    // predicate's doing and not the fixture's -- these timings are 31x, and this
    // test would pass for the wrong reason at `selected === catalogTotal`.
    //
    // Silence is correct because a narrow canary is one run per DISTINCT narrowing
    // command: its cost scales with the mutants in the run, so batching does not
    // amortise it. Once the full-suite baseline has been served, there is no fixed
    // cost left here for `run --all` to spread.
    const gates = measuredGates();
    const text = formatReport(baseReport({
      gates: {
        baseline: { ...gates.baseline, fromCache: true, measuredDurationMs: 67_500, durationMs: 0 },
        canary: narrowCanary(),
      },
      timings: { totalMs: 70_000, gatesMs: 67_600, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.match(text, /gatesMs covers the canary only/);
    assert.match(text, /NONE of gatesMs is fixed per invocation/, 'and says why the note is absent');
    assert.doesNotMatch(text, NOTE);
    // gate-cache.test.mjs N13 asserts this exact string is ABSENT on a half-hit;
    // the cost block must not be the thing that resurrects it.
    assert.doesNotMatch(text, /GATES FROM CACHE/);
  });

  test('C11b: a half-hit whose canary ran at BASELINE scope re-paid a whole suite, so it fires', () => {
    // THE HOLE a naive `baseline.fromCache` suppression would open. `run` reaches
    // baseline canary scope whenever nothing is narrow-canary-eligible
    // (mutants.schema.md, "The canary's scope"), and that canary IS a whole
    // baselineCommand run -- re-paid every invocation, exactly the pathology. The
    // discriminator is the canary's scope, never merely that the baseline was
    // served.
    const gates = measuredGates();
    const text = formatReport(baseReport({
      gates: {
        baseline: { ...gates.baseline, fromCache: true, measuredDurationMs: 67_500, durationMs: 0 },
        canary: gates.canary,
      },
      timings: { totalMs: 70_000, gatesMs: 67_600, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.match(text, NOTE);
    assert.match(text, /31\.4x/, 'the ratio is against the whole-suite canary it really re-paid');
  });

  test('C12: a report with no selection prints the table but never the note', () => {
    // `probe` and `baseline` set no selection, and neither does any hand-built or
    // older report. Absent is treated as UNSATISFIED, never guessed: a missed note
    // costs nothing, a false one teaches the reader to skip it.
    const text = formatReport(baseReport({
      command: 'probe',
      selection: undefined,
      timings: PER_MUTANT_INVOCATION.timings,
    }));

    assert.doesNotMatch(text, NOTE);
    assert.match(text, /Cost {2}\[totalMs 137250\]/);
  });

  test('C13: a failed-gate run prints the Cost block, above the banner, and no note', () => {
    // A failed gate's cost is part of what a run costs -- deriveTimings wraps
    // every early return for exactly that reason -- and the summary returns early
    // here, so a block emitted after that point would never print on the run whose
    // cost is most likely to have been wasted. Nothing was measured, so nothing
    // about batching is the lesson.
    const gates = measuredGates();
    const text = formatReport(baseReport({
      gates: {
        baseline: { ...gates.baseline, outcome: GateOutcome.FAILED, detail: '1 test failed' },
      },
      timings: { totalMs: 68_000, gatesMs: 67_500, narrowBaselinesMs: 0, mutantsMs: 0 },
      selection: { catalogTotal: 35, selected: 1 },
      results: [],
    }));

    assert.match(text, /Cost {2}\[totalMs 68000\]/);
    assert.doesNotMatch(text, NOTE);
    assert.ok(
      text.indexOf('Cost  [totalMs') < text.indexOf('THE HARNESS IS NOT TRUSTWORTHY'),
      'the cost block must print before the early return, not after it',
    );
  });
});

describe('each conjunct and each guard is separately load-bearing', () => {
  test('C15: a DOMINATING ratio over the WHOLE catalog stays silent', () => {
    // CRITERION 3, discriminated. C8's fixture is doubly silent -- it fails the
    // ratio conjunct AND the headroom conjunct -- so it passes against a
    // ratio-only implementation with the headroom conjunct deleted. This fixture
    // is the field run's own 62.8x with the whole catalog carried: the ONLY thing
    // holding the note back is `selected === catalogTotal`, so a ratio-only
    // predicate fails here and nothing else in this file catches that.
    const text = formatReport(baseReport({
      timings: PER_MUTANT_INVOCATION.timings,
      selection: { catalogTotal: 35, selected: 35 },
    }));

    assert.doesNotMatch(text, NOTE);
  });

  test('C16: 9.9x stays silent and 10.0x fires -- the threshold, and that it is >=', () => {
    // Without a boundary pair any threshold in (3.3, 62.8] passes this file, so
    // the documented 10x would be free to drift to 2 or 50 unnoticed.
    const at = (gatesMs) => formatReport(baseReport({
      timings: { totalMs: gatesMs + 1_000, gatesMs, narrowBaselinesMs: 1_000, mutantsMs: 0 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.doesNotMatch(at(9_900), NOTE, '9.9x is below the threshold');
    assert.match(at(10_000), NOTE, '10.0x must fire -- the comparison is >=, not >');
  });

  test('C17: absent measurement buckets stay silent rather than dividing by nothing', () => {
    // A missing bucket coerced to 0 makes the ratio infinite, so the note would
    // fire on incomplete data -- and would cite "0 ms of measurement" while the
    // table directly above renders those same buckets as `-`. Absent-or-unusable
    // stays silent, and the note's arithmetic stays checkable against the table.
    const text = formatReport(baseReport({
      timings: { totalMs: 5_000, gatesMs: 100 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.doesNotMatch(text, NOTE);
    assert.match(text, /narrowBaselinesMs\s+\|\s+-\s+\|\s+-/, 'the table still says they are absent');
  });

  test('C18: zero measured cost stays silent -- there is no ratio to take', () => {
    // The buckets are present and really are zero (a run whose mutants errored
    // before any command). Firing here would divide by nothing; the same rule as
    // C17 applies to a real zero as to a missing key.
    const text = formatReport(baseReport({
      timings: { totalMs: 5_000, gatesMs: 4_900, narrowBaselinesMs: 0, mutantsMs: 0 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.doesNotMatch(text, NOTE);
  });

  test('C19a: a MIXED canary contributes its baseline half only, net of scopes[]', () => {
    // The one arm of fixedGateMs that does arithmetic, and the only test of its
    // clamp. Hand-checkable: a 67600 ms mixed canary with 1000 ms of narrow scopes
    // has a 66600 ms baseline half, and the served baseline adds nothing. An
    // implementation crediting the whole canary would say 67600 and 31.4x.
    const gates = measuredGates();
    const text = formatReport(baseReport({
      gates: {
        baseline: { ...gates.baseline, fromCache: true, measuredDurationMs: 67_500, durationMs: 0 },
        canary: {
          ...gates.canary,
          scope: 'mixed',
          durationMs: 67_600,
          scopes: [{ command: 'c', target: 't', status: 'KILLED', grade: 'counted', attempts: [], durationMs: 1_000, detail: 'k', mutants: ['m1'], skipped: null }],
        },
      },
      timings: { totalMs: 70_000, gatesMs: 67_600, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.match(text, /Of gatesMs, 66600 ms is FIXED per invocation/);
    assert.match(text, NOTE);
    assert.match(text, /66600 ms of fixed gate cost bought 2150 ms of measurement \(31\.0x\)/);
  });

  test('C19b: a canary scope this cannot read contributes nothing', () => {
    // Every unknown in fixedGateMs biases toward silence. Crediting an
    // unrecognised scope as whole-suite would fire the note off data the renderer
    // does not understand -- the same defect class as a coerced-to-zero bucket.
    const gates = measuredGates();
    const text = formatReport(baseReport({
      gates: {
        baseline: { ...gates.baseline, fromCache: true, measuredDurationMs: 67_500, durationMs: 0 },
        canary: { ...gates.canary, scope: 'something-new', durationMs: 67_600, scopes: null },
      },
      timings: { totalMs: 70_000, gatesMs: 67_600, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
      selection: { catalogTotal: 35, selected: 1 },
    }));

    assert.doesNotMatch(text, NOTE);
    assert.match(text, /NONE of gatesMs is fixed per invocation/);
  });

  test('C19: the fixed share of gatesMs is named when it is only part of it', () => {
    // What makes the note's numerator checkable against the table. A narrow canary
    // sits inside gatesMs but is NOT fixed per invocation, so labelling the whole
    // bucket "fixed" would be false on any narrowing run.
    const gates = measuredGates();
    const narrowed = formatReport(baseReport({
      gates: { baseline: gates.baseline, canary: narrowCanary(2_000) },
      timings: { totalMs: 70_000, gatesMs: 69_500, narrowBaselinesMs: 1_000, mutantsMs: 1_150 },
    }));

    assert.match(narrowed, /Of gatesMs, 67500 ms is FIXED per invocation/);
    assert.match(narrowed, /scales with the mutants in the run/);
    // And the whole bucket really is fixed when both gates ran the whole suite.
    assert.match(formatReport(baseReport()), /gatesMs is FIXED per invocation/);
    assert.doesNotMatch(formatReport(baseReport()), /Of gatesMs/);
  });
});

describe('the block is reachable from a real invocation', () => {
  test('C14: `run --all` sets selection, and the printed table is that report own numbers', async () => {
    // The one end-to-end test here. The unit tests above cannot see whether
    // commandRun actually populates `selection`, and a predicate whose second
    // conjunct is never populated is silent forever -- a diagnostic that never
    // fires is indistinguishable from one that was never written.
    //
    // ONE invocation, re-rendered in process: the printed cells are compared
    // against the very report they were rendered from, so this cannot drift with
    // the machine. No wall-clock magnitude is asserted (CONVENTIONS), only that
    // the table repeats the breakdown faithfully -- the printed half of
    // timings.test.mjs T4.
    const repo = makeRepo({
      files: costFiles({ modules: 2, workIterations: 0 }),
      config: costConfig(),
      mutants: costMutants(2),
      label: 'cost-summary-cli',
    });
    try {
      const cli = await runCli(['run', '--all', '--json'], { cwd: repo.root, timeoutMs: 300_000 });
      const report = JSON.parse(cli.stdout);

      assert.equal(report.selection.catalogTotal, 2, JSON.stringify(report.selection));
      assert.equal(report.selection.selected, 2, 'a --all run carried the whole catalog');

      const text = formatReport(report);
      assert.match(text, /Cost {2}\[totalMs \d+\]/, text);
      // A whole-catalog run: the headroom conjunct is false by construction, so
      // the note cannot fire however the gates and mutants priced out.
      assert.doesNotMatch(text, NOTE);

      for (const bucket of ['gatesMs', 'narrowBaselinesMs', 'mutantsMs']) {
        const row = new RegExp(`${bucket}\\s+\\|\\s+(\\d+)\\s+\\|`).exec(text);
        assert.ok(row, `${bucket} row missing from:\n${text}`);
        assert.equal(
          Number(row[1]),
          Math.round(report.timings[bucket]),
          `${bucket}: the printed cell must be the report own number`,
        );
      }
    } finally { repo.cleanup(); }
  });
});
