// Learn-mode labelling, at the report layer. Pure unit tests over hand-built
// report objects (mirrors classify.test.mjs's style) -- no fixture, no subprocess,
// so this runs no suite and stays fast.
//
// The user's explicit requirement: a learn result must never render a ref in a
// column that reads like a grading claim, and LEARNED must be visibly distinct
// from KILLED/IMPRECISE. Every assertion below is anchored to that.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Verdict } from '../lib/classify.mjs';
import { exitCodeFor, formatReport, toJson } from '../lib/report.mjs';

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
    narrowing: { mode: 'file', command: "node --test 'test/a.test.mjs'", scopes: ['test/a.test.mjs'], requestedNames: false, downgradeReason: null, placeholder: true },
    mutation: [{ kind: 'anchor', file: 'src/a.mjs', edits: [{ anchor: 'x', replacement: 'y', line: 1 }] }],
    failedTests: [],
    unexpectedFailures: [],
    missingFailures: [],
    narrowBaseline: { command: "node --test 'test/a.test.mjs'", green: true, counts: { passed: 1, failed: 0, skipped: 0, ran: 1 } },
    mutantCounts: { passed: 0, failed: 1, skipped: 0, ran: 1 },
    delta: { passed: -1, failed: 1, skipped: 0 },
    canary: null,
    exitCode: 1,
    durationMs: 10,
    ...extra,
  };
}

function baseReport(extra = {}) {
  return {
    command: 'run',
    isolation: 'in-place',
    jobs: 1,
    workspaceRoot: '/tmp/x',
    adapter: { name: 'node-test', grade: 'counted', modulePath: null },
    gates: {},
    mutatedSha: 'abc123',
    reproducible: true,
    noTrace: null,
    ...extra,
  };
}

describe('the LEARN MODE banner', () => {
  test('prints on a learn report and not on a graded report', () => {
    const learnText = formatReport(baseReport({ learn: true, results: [result({ verdict: Verdict.LEARNED })] }));
    const gradedText = formatReport(baseReport({ learn: false, results: [result({ verdict: Verdict.KILLED })] }));
    assert.match(learnText, /LEARN MODE/);
    assert.doesNotMatch(gradedText, /LEARN MODE/);
  });
});

describe('matrix header labelling', () => {
  test('a learn report\'s header has "scope", not "expected"; a graded report keeps "expected"', () => {
    const learnText = formatReport(baseReport({ learn: true, results: [result({ verdict: Verdict.LEARNED })] }));
    const gradedText = formatReport(baseReport({ learn: false, results: [result({ verdict: Verdict.KILLED })] }));

    const learnHeaderLine = learnText.split('\n').find((l) => l.includes('| verdict |'));
    const gradedHeaderLine = gradedText.split('\n').find((l) => l.includes('| verdict |'));

    assert.match(learnHeaderLine, /\bscope\b/);
    assert.doesNotMatch(learnHeaderLine, /\bexpected\b/);
    assert.match(gradedHeaderLine, /\bexpected\b/);
  });
});

describe('the scope column renders resolved narrowing scopes, never the raw ref', () => {
  test('a ref passed as a scope hint only shows up via narrowing.scopes', () => {
    const text = formatReport(baseReport({
      learn: true,
      results: [result({
        verdict: Verdict.LEARNED,
        expectFail: ['test/bogus.test.mjs::not-a-real-scope-marker'],
        narrowing: { mode: 'file', command: "node --test 'test/a.test.mjs'", scopes: ['test/a.test.mjs'], requestedNames: false, downgradeReason: null, placeholder: true },
      })],
    }));
    assert.doesNotMatch(text, /not-a-real-scope-marker/);
    assert.match(text, /test\/a\.test\.mjs/);
  });

  test('an empty scopes array renders "(whole suite)"', () => {
    const text = formatReport(baseReport({
      learn: true,
      results: [result({
        verdict: Verdict.SURVIVED,
        expectFail: [],
        narrowing: { mode: 'whole', command: 'node --test', scopes: [], requestedNames: false, downgradeReason: null, placeholder: false },
      })],
    }));
    assert.match(text, /\(whole suite\)/);
  });
});

describe('LEARNED is its own verdict token', () => {
  test('LEARNED renders in the matrix and sorts after SURVIVED', () => {
    const text = formatReport(baseReport({
      learn: true,
      results: [
        result({ id: 'survived', verdict: Verdict.SURVIVED, expectFail: [] }),
        result({ id: 'learned', verdict: Verdict.LEARNED, failedTests: ['test/a.test.mjs::one'] }),
      ],
    }));
    const rows = text.split('\n').filter((l) => l.includes('survived') || l.includes('learned'));
    assert.match(text, /\bLEARNED\b/);
    const survivedIndex = rows.findIndex((l) => l.startsWith('  survived'));
    const learnedIndex = rows.findIndex((l) => l.startsWith('  learned'));
    assert.ok(survivedIndex >= 0 && learnedIndex >= 0);
    assert.ok(survivedIndex < learnedIndex, 'SURVIVED must sort before LEARNED');
  });
});

describe('the survivor block in learn mode', () => {
  test('a learn SURVIVED prints "observed:" and not "claim:"', () => {
    const text = formatReport(baseReport({
      learn: true,
      results: [result({ verdict: Verdict.SURVIVED, expectFail: [] })],
    }));
    assert.match(text, /observed:\s+no test failed/);
    assert.doesNotMatch(text, /claim:/);
  });

  test('a graded SURVIVED still prints "claim:"', () => {
    const text = formatReport(baseReport({
      learn: false,
      results: [result({ verdict: Verdict.SURVIVED })],
    }));
    assert.match(text, /claim:/);
  });
});

describe('toJson and exitCodeFor', () => {
  test('summary.learned counts LEARNED results', () => {
    const report = baseReport({
      learn: true,
      results: [
        result({ id: 'a', verdict: Verdict.LEARNED }),
        result({ id: 'b', verdict: Verdict.LEARNED }),
        result({ id: 'c', verdict: Verdict.SURVIVED, expectFail: [] }),
      ],
    });
    assert.equal(toJson(report).summary.learned, 2);
  });

  test('an all-LEARNED report exits 0; one SURVIVED among them exits 1', () => {
    const clean = baseReport({ learn: true, results: [result({ verdict: Verdict.LEARNED })] });
    assert.equal(exitCodeFor(clean), 0);

    const withSurvivor = baseReport({
      learn: true,
      results: [
        result({ id: 'a', verdict: Verdict.LEARNED }),
        result({ id: 'b', verdict: Verdict.SURVIVED, expectFail: [] }),
      ],
    });
    assert.equal(exitCodeFor(withSurvivor), 1);
  });
});
