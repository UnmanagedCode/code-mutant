// Hang reporting, at the report layer. Pure unit tests over hand-built report
// objects (mirrors learn-report.test.mjs) -- no fixture, no subprocess.
//
// Two properties, both of which the 2026-0183 phantom-regression failure needed:
// an ungraded result must be COUNTABLE apart from its sibling kind, and a hang
// must name who to blame in the printed output. Collapsed into one `noVerdict`
// number and one undifferentiated list, "the catalog is stale" and "the project's
// suite does not terminate" read identically -- and they route to different people.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Reason, Verdict } from '../lib/classify.mjs';
import { formatReport, toJson } from '../lib/report.mjs';

function result(extra = {}) {
  return {
    id: 'm1',
    invariant: 'an invariant',
    whyNotEquivalent: 'not equivalent',
    waived: null,
    expectFail: ['test/a.test.mjs::one'],
    expectPass: [],
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
    failedTests: [],
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

function baseReport(results) {
  return {
    command: 'run',
    isolation: 'in-place',
    jobs: 1,
    learn: false,
    workspaceRoot: '/tmp/x',
    adapter: { name: 'node-test', grade: 'counted', modulePath: null },
    gates: {},
    narrowBaselines: [],
    timings: { totalMs: 1, gatesMs: 0, narrowBaselinesMs: 0, mutantsMs: 0 },
    mutatedSha: 'abc123',
    reproducible: true,
    noTrace: null,
    results,
  };
}

describe('hangs are separately countable and separately blamed', () => {
  test('4: TIMEOUT and ERROR are counted apart from each other, and still sum to noVerdict', () => {
    const json = toJson(baseReport([
      result({
        id: 'hung',
        verdict: Verdict.TIMEOUT,
        reason: Reason.TIMED_OUT,
        hang: { blame: 'mutation', deadlineMs: 400, referenceMs: 100 },
      }),
      result({ id: 'stale', verdict: Verdict.ERROR, reason: Reason.SCOPE_NON_GREEN }),
      result({ id: 'good', verdict: Verdict.KILLED, failedTests: ['test/a.test.mjs::one'] }),
    ]));

    assert.equal(json.summary.timedOut, 1);
    assert.equal(json.summary.errored, 1);
    assert.equal(json.summary.noVerdict, 2);
    // Documented as an identity rather than duplicated as a third field.
    assert.equal(json.summary.errored + json.summary.timedOut, json.summary.noVerdict);
    assert.equal(json.summary.killed, 1);
  });

  test('5: the printed report names the blame, and distinguishes the two blames', () => {
    const suiteText = formatReport(baseReport([
      result({
        id: 'hung',
        verdict: Verdict.TIMEOUT,
        reason: Reason.SCOPE_TIMED_OUT,
        hang: { blame: 'suite', deadlineMs: 300_000, referenceMs: null },
      }),
    ]));
    assert.match(suiteText, /Hangs/);
    assert.match(suiteText, /suite/);
    assert.match(suiteText, /not a mutant to rewrite/);
    // A suite hang has no reference, and saying so beats printing a number that
    // was never measured.
    assert.match(suiteText, /\(not measured\)/);

    const mutationText = formatReport(baseReport([
      result({
        id: 'hung',
        verdict: Verdict.TIMEOUT,
        reason: Reason.TIMED_OUT,
        hang: { blame: 'mutation', deadlineMs: 400, referenceMs: 100 },
      }),
    ]));
    assert.match(mutationText, /Hangs/);
    assert.match(mutationText, /mutation/);
    assert.match(mutationText, /100ms/, 'the reference the deadline was derived from must be shown');
    assert.match(mutationText, /rewrite it smaller/);
  });

  test('5b: a report with no hang prints no Hangs section', () => {
    // The negative direction: an unconditional section would make the heading
    // meaningless, and an ERROR that is not a hang must not be filed as one.
    const text = formatReport(baseReport([
      result({ id: 'stale', verdict: Verdict.ERROR, reason: Reason.SCOPE_NON_GREEN }),
    ]));
    assert.doesNotMatch(text, /Hangs/);
    assert.match(text, /No verdict from 1 mutant/);
  });
});
