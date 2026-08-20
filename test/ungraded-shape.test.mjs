// AN UNGRADED RESULT MUST NOT BE SHAPE-IDENTICAL TO A SURVIVOR.
//
// The 2026-0183 failure was a consumer collapsing ungraded results into
// survivors, and it was possible because both carried `failedTests: []` -- the
// one field the consumer looked at. "Impossible for a JSON consumer" is not
// achievable; the strongest achievable property is:
//
//   No field on an ungraded result carries the value it would carry on a
//   SURVIVED result.
//
// Three independent fields now separate them (`graded`, `reason`, `failedTests`),
// so a consumer keyed on any one of the three reads correctly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import {
  GRADED_REASONS, Reason, UNGRADED_REASONS, Verdict, isGraded,
} from '../lib/classify.mjs';
import { toJson } from '../lib/report.mjs';
import { makeRepo } from './helpers/tmp-repo.mjs';
import { costConfig, costFiles, costMutants } from './helpers/cost-project.mjs';

describe('ungraded results are distinguishable from survivors', () => {
  test('8: the reason partition is total over Reason and disjoint', () => {
    const all = new Set(Object.values(Reason));
    const union = new Set([...GRADED_REASONS, ...UNGRADED_REASONS]);

    // Total: a reason in neither set means someone added one without deciding
    // whether it represents a verdict.
    for (const reason of all) {
      assert.ok(union.has(reason), `Reason "${reason}" is in neither GRADED_REASONS nor UNGRADED_REASONS`);
    }
    // And nothing invented: no set member that is not a real reason.
    for (const reason of union) {
      assert.ok(all.has(reason), `"${reason}" is classified but is not a value of Reason`);
    }
    assert.equal(union.size, all.size);

    // Disjoint.
    for (const reason of GRADED_REASONS) {
      assert.ok(!UNGRADED_REASONS.has(reason), `Reason "${reason}" is in BOTH sets`);
    }
  });

  test('8b: every graded reason belongs to a graded verdict, and vice versa', () => {
    // The partition is only worth anything if it agrees with the verdict split
    // that `graded` is actually derived from. All four graded reasons are
    // IMPRECISE; every ungraded reason belongs to ERROR or TIMEOUT.
    assert.ok(isGraded(Verdict.IMPRECISE));
    for (const verdict of [Verdict.KILLED, Verdict.SURVIVED, Verdict.LEARNED]) {
      assert.ok(isGraded(verdict), verdict);
    }
    for (const verdict of [Verdict.ERROR, Verdict.TIMEOUT]) {
      assert.ok(!isGraded(verdict), verdict);
    }
    assert.equal(GRADED_REASONS.size, 4, 'the graded reasons are the four IMPRECISE ones');
  });

  test('9: a survivor and an ungraded result differ at three independent fields', async () => {
    // One run producing both, so the comparison is between two results the same
    // invocation actually built -- not two hand-written objects.
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'ungraded-shape',
    });
    try {
      const [covered] = costMutants(1);
      const config = loadConfig({ repoRoot: repo.root });
      const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
      const report = await execute({
        config,
        adapter,
        mutants: [
          // A survivor: the mutation lands on a value no test asserts against.
          {
            id: 'survivor',
            invariant: 'the label is pinned',
            sites: [{ file: 'src/m01.mjs', anchor: "export const label = 'm01';", replacement: "export const label = 'm01'; export const unused = 1;" }],
            expectFail: ['test/m01.test.mjs::m01 limit is pinned'],
            expectPass: [],
            whyNotEquivalent: 'adds an export nothing asserts on',
          },
          // An ungraded result: a stale anchor, which never reaches Phase B.
          { ...covered, id: 'stale', sites: [{ file: 'src/m00.mjs', anchor: 'return 999;', replacement: 'return 0;' }] },
        ],
      });

      const json = toJson(report);
      const survivor = json.results.find((r) => r.id === 'survivor');
      const ungraded = json.results.find((r) => r.id === 'stale');

      assert.equal(survivor.verdict, Verdict.SURVIVED, survivor.detail);
      assert.deepEqual(
        { graded: survivor.graded, reason: survivor.reason, failedTests: survivor.failedTests },
        { graded: true, reason: null, failedTests: [] },
      );

      assert.equal(ungraded.verdict, Verdict.ERROR, ungraded.detail);
      assert.equal(ungraded.graded, false);
      assert.equal(ungraded.reason, 'anchor-missing');
      assert.equal(ungraded.failedTests, null);

      // THE PROPERTY: pairwise unequal on all three, so a consumer keyed on any
      // one of them reads correctly. `failedTests` is the one that mattered --
      // both used to be `[]`.
      assert.notEqual(ungraded.graded, survivor.graded);
      assert.notEqual(ungraded.reason, survivor.reason);
      assert.notDeepEqual(ungraded.failedTests, survivor.failedTests);

      // The sibling list fields follow the same rule.
      assert.equal(ungraded.unexpectedFailures, null);
      assert.equal(ungraded.missingFailures, null);
      assert.deepEqual(survivor.unexpectedFailures, []);
    } finally { repo.cleanup(); }
  });

  test('10: a TIMEOUT is ungraded too, and is counted as a timeout rather than a kill', () => {
    const json = toJson({
      command: 'run',
      isolation: 'copy',
      jobs: 1,
      learn: false,
      adapter: { name: 'node-test', grade: 'counted', modulePath: null },
      gates: {},
      narrowBaselines: [],
      timings: { totalMs: 1, gatesMs: 0, narrowBaselinesMs: 0, mutantsMs: 0 },
      mutatedSha: 'abc',
      reproducible: true,
      noTrace: null,
      results: [{
        id: 'hung',
        invariant: 'an invariant',
        waived: null,
        verdict: Verdict.TIMEOUT,
        reason: Reason.TIMED_OUT,
        detail: 'killed at the deadline',
        failedTests: null,
        hang: { blame: 'mutation', deadlineMs: 400, referenceMs: 100 },
      }],
    });

    assert.equal(json.results[0].graded, false);
    assert.equal(json.summary.timedOut, 1);
    assert.equal(json.summary.killed, 0);
    assert.equal(json.summary.survivors, 0);
    assert.equal(json.summary.noVerdict, 1);
  });
});
