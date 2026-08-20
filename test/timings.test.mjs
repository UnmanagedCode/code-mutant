// THE COST MODEL, pinned structurally.
//
// These tests assert WHICH SCOPE was measured and HOW MANY TIMES -- never how
// long anything took. Wall-clock assertions would make them machine-dependent
// and CONVENTIONS forbids them; the durations themselves are read from the report
// by hand when the cost breakdown is being measured, which is what the new fields
// are for.
//
// T1 and T2 pin behaviour that is ALREADY CORRECT. They are regression pins for
// the cost model the later commits must not break, and they fail against the
// unfixed tree only because the fields they read did not exist. Neither is a
// claim that this commit fixed a bug.
//
// `workIterations: 0` throughout: the >=8x whole-suite:single-file ratio is a
// precondition of the measurement, not of these assertions.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { Verdict } from '../lib/classify.mjs';
import { makeRepo } from './helpers/tmp-repo.mjs';
import {
  costConfig, costFiles, costMutants, sharedScopeMutants,
} from './helpers/cost-project.mjs';

async function run(repo, mutants) {
  const config = loadConfig({ repoRoot: repo.root });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  const report = await execute({ config, adapter, mutants });
  return { report, config };
}

describe('cost model', () => {
  test('T1: a graded run narrows -- it does not run the whole suite per mutant', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'cost-narrowed',
    });
    try {
      const { report, config } = await run(repo, costMutants(4));

      // One narrow baseline per distinct scope, and four mutants with four
      // distinct scopes means four -- not one whole-suite run each.
      assert.equal(report.narrowBaselines.length, 4, JSON.stringify(report.narrowBaselines, null, 2));
      for (const baseline of report.narrowBaselines) {
        assert.equal(baseline.green, true, baseline.command);
        assert.equal(typeof baseline.durationMs, 'number');
        assert.notEqual(baseline.command, config.baselineCommand);
      }

      for (const result of report.results) {
        assert.equal(result.verdict, Verdict.KILLED, `${result.id}: ${result.detail}`);
        // Exactly one test file in the scope. A whole-suite command names none,
        // so the count is what separates "narrowed" from "did not narrow".
        const named = result.narrowing.command.match(/test\/m\d\d\.test\.mjs/g) ?? [];
        assert.equal(named.length, 1, result.narrowing.command);
        assert.notEqual(result.narrowing.command, config.baselineCommand);
      }
    } finally { repo.cleanup(); }
  });

  test('T2: mutants sharing a scope pay one narrow baseline between them', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'cost-shared',
    });
    try {
      const { report } = await run(repo, sharedScopeMutants());

      assert.equal(report.results.length, 2);
      assert.equal(
        report.narrowBaselines.length,
        1,
        `two mutants at one scope must be measured once: ${JSON.stringify(report.narrowBaselines)}`,
      );
      assert.equal(report.results[0].narrowBaseline.command, report.results[1].narrowBaseline.command);
      assert.equal(report.results[0].narrowBaseline.command, report.narrowBaselines[0].command);
    } finally { repo.cleanup(); }
  });

  test('T3: every canary attempt carries its own cost', async () => {
    // baselineCommand scoped to the LAST module, so the earlier candidates the
    // gate tries sit outside the command's scope and their attempts are recorded
    // rather than fired. This is the shape that makes the attempt count -- and
    // therefore the attempt cost -- non-zero.
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig({ baselineCommand: 'node --test --test-concurrency=1 test/m03.test.mjs' }),
      label: 'cost-canary',
    });
    try {
      const { report } = await run(repo, costMutants(1));

      const canary = report.gates.canary;
      assert.ok(canary.attempts.length >= 1, `expected recorded attempts, got ${JSON.stringify(canary)}`);
      for (const attempt of canary.attempts) {
        assert.equal(typeof attempt.durationMs, 'number', JSON.stringify(attempt));
      }
      // The gate still fired, so the attempts above are the cost of GETTING there
      // rather than the cost of a failed gate.
      assert.equal(canary.status, 'KILLED', canary.detail);
      assert.equal(canary.target, 'test/m03.test.mjs');
      assert.equal(typeof canary.durationMs, 'number');
    } finally { repo.cleanup(); }
  });

  test('T4: the breakdown is derived from the numbers it sums, not accumulated beside them', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'cost-derived',
    });
    try {
      const { report } = await run(repo, costMutants(2));
      const { timings } = report;
      const sum = (list, pick) => list.reduce((acc, item) => acc + pick(item), 0);

      assert.equal(timings.gatesMs, report.gates.baseline.durationMs + report.gates.canary.durationMs);
      assert.equal(timings.narrowBaselinesMs, sum(report.narrowBaselines, (b) => b.durationMs));
      assert.equal(timings.mutantsMs, sum(report.results, (r) => r.durationMs));
      // Every component is inside the run, so the total bounds all of them.
      assert.ok(timings.totalMs >= timings.gatesMs, `${timings.totalMs} < ${timings.gatesMs}`);
      assert.ok(timings.totalMs >= timings.mutantsMs, `${timings.totalMs} < ${timings.mutantsMs}`);
    } finally { repo.cleanup(); }
  });

  test('T5: a mutant reports its own three phases, and they account for its total', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'cost-phases',
    });
    try {
      const { report } = await run(repo, costMutants(1));
      const result = report.results[0];

      assert.equal(result.verdict, Verdict.KILLED, result.detail);
      for (const phase of ['applyMs', 'measureMs', 'restoreMs']) {
        assert.equal(typeof result[phase], 'number', `${phase}: ${result[phase]}`);
      }
      // Ordering, not duration: the three phases are disjoint slices of the
      // mutant's own wall clock, so they cannot outrun it.
      assert.ok(
        result.applyMs + result.measureMs + result.restoreMs <= result.durationMs,
        `phases ${result.applyMs}+${result.measureMs}+${result.restoreMs} exceed total ${result.durationMs}`,
      );
      // The project's command dominates the harness's own apply/restore work --
      // the claim the whole cost breakdown rests on.
      assert.ok(result.measureMs > result.applyMs + result.restoreMs, JSON.stringify(result));
    } finally { repo.cleanup(); }
  });

  test('T6: a mutant whose scope was never usable reports no measured phase', async () => {
    // A stale anchor never reaches Phase B, so there is nothing to attribute a
    // phase cost to. `null` says that; `0` would read as "it ran and was free".
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'cost-unrun',
    });
    try {
      const { report } = await run(repo, [{
        ...costMutants(1)[0],
        id: 'stale',
        sites: [{ file: 'src/m00.mjs', anchor: 'return 999;', replacement: 'return 0;' }],
      }]);
      const result = report.results[0];

      assert.equal(result.verdict, Verdict.ERROR);
      assert.equal(result.applyMs, null);
      assert.equal(result.measureMs, null);
      assert.equal(result.restoreMs, null);
    } finally { repo.cleanup(); }
  });
});
