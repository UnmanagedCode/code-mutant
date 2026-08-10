// Per-mutant orchestration: resolve, gate, apply, run, classify, restore.
//
// Split into two phases on purpose:
//
//   Phase A runs entirely against an UNMUTATED tree -- baseline gate, canary
//   gate, site resolution, narrowing plans, and every per-scope narrow baseline.
//   Measuring a narrow baseline lazily would be a correctness bug under --jobs:
//   worker 2 could measure "unmutated" while worker 1 has a mutation applied to
//   the same copy.
//
//   Phase B applies mutations. In copy mode each worker owns its own copy, so
//   nothing is shared; in-place is always single-worker.

import {
  CanaryStatus, GateOutcome, checkBaseDiffGate, checkCleanTree, createNarrowBaselineCache, headSha,
  runBaselineGate, runCanaryGate,
} from './gates.mjs';
import { errorResult, runMutant } from './mutant-run.mjs';
import { planNarrowing } from './narrow.mjs';
import { SiteError, resolveSites } from './sites.mjs';
import { openWorkspace } from './workspace.mjs';

export { GateOutcome };

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function execute({
  config, adapter, mutants, log = () => {}, resultForEmptyCatalog = true,
  allowDirty = false, enforceCleanTree = true, checkBaseDiff = false, base = null,
}) {
  const report = {
    isolation: config.isolation,
    // Not simply `config.jobs`: in-place isolation always runs serially (workers
    // sharing one tree would restore over each other), and the report must say
    // so regardless of whether the config layer's own clamp ran -- runner.mjs
    // owns the isolation-vs-concurrency rule for its own execution, so it does
    // not trust an upstream value to already reflect it.
    jobs: config.isolation === 'in-place' ? 1 : config.jobs,
    workspaceRoot: null,
    adapter: { name: adapter.name, grade: adapter.grade, modulePath: adapter.modulePath ?? null },
    gates: {},
    results: [],
    noTrace: null,
    // So a survivor is re-runnable against a sha by anyone -- the whole point of
    // the clean-tree precondition below.
    mutatedSha: headSha(config.repoRoot),
    reproducible: true,
  };

  // ---- The third trust gate: mutation must run against committed state ----
  // Checked before baseline and canary, and before any workspace is opened --
  // copy mode would otherwise pay for a full tree copy before refusing.
  if (enforceCleanTree) {
    const clean = checkCleanTree(config.repoRoot);
    const dirty = !clean.clean;
    report.gates.cleanTree = {
      outcome: dirty && !allowDirty ? GateOutcome.FAILED : GateOutcome.PASSED,
      code: dirty && !allowDirty ? 'dirty-tree' : null,
      dirty,
      allowedDirty: dirty && allowDirty,
      detail: !dirty
        ? 'worktree is clean'
        : (allowDirty
          ? 'worktree has uncommitted or untracked changes; proceeding under --allow-dirty -- every '
            + 'verdict from this run is non-reproducible'
          : 'worktree has uncommitted or untracked changes, so mutation would not run against committed, '
            + `re-runnable state:\n${clean.status}`),
    };
    if (dirty) {
      if (!allowDirty) {
        log(`clean-tree FAILED: ${report.gates.cleanTree.detail}`);
        return report;
      }
      // Reaching here means dirty AND allowDirty: proceeding, but non-reproducible.
      report.reproducible = false;
      log('clean-tree: dirty, proceeding under --allow-dirty (non-reproducible)');
    }
  }

  if (checkBaseDiff) {
    const baseDiff = checkBaseDiffGate(config.repoRoot, base);
    report.gates.baseDiff = baseDiff;
    if (baseDiff.outcome === GateOutcome.FAILED) {
      log(`base-diff FAILED: ${baseDiff.detail}`);
      return report;
    }
    log(`base-diff: ${baseDiff.outcome}${baseDiff.base ? ` (vs ${baseDiff.base})` : ''}`);
  }

  const workspaces = [];
  const openCount = config.isolation === 'copy' ? Math.max(1, Math.min(config.jobs, Math.max(mutants.length, 1))) : 1;
  for (let i = 0; i < openCount; i += 1) {
    workspaces.push(openWorkspace({
      repoRoot: config.repoRoot,
      isolation: config.isolation,
      preserve: config.preserve,
      label: `w${i}`,
    }));
  }
  const primary = workspaces[0];
  report.workspaceRoot = primary.root;

  try {
    // ---- Phase A: gates and planning, against an unmutated tree -----------
    log(`baseline: ${config.baselineCommand}`);
    const baseline = await runBaselineGate({ config, adapter, workspace: primary });
    report.gates.baseline = {
      outcome: baseline.green ? GateOutcome.PASSED : GateOutcome.FAILED,
      command: baseline.command,
      counts: baseline.counts ?? null,
      exitCode: baseline.run.exitCode,
      failedTests: baseline.failedTests ?? null,
      detail: baseline.detail,
    };
    if (!baseline.green) {
      log(`baseline FAILED: ${baseline.detail}`);
      return report;
    }
    log(`baseline green${baseline.counts ? ` (${baseline.counts.passed} passed, ${baseline.counts.skipped} skipped, ${baseline.counts.ran} ran)` : ''}`);

    // Resolve every site before anything is applied, so a stale anchor in mutant
    // 5 cannot leave mutant 4's edit sitting in the tree.
    const planned = [];
    for (const mutant of mutants) {
      try {
        const resolvedSites = resolveSites(primary.root, mutant.sites);
        const narrowing = planNarrowing({ mutant, adapter, testCommand: config.testCommand });
        planned.push({ mutant, resolvedSites, narrowing, error: null });
      } catch (err) {
        const reason = err instanceof SiteError ? err.code : 'plan-failed';
        planned.push({ mutant, error: errorResult(mutant, reason, err.message) });
      }
    }

    const preferredFiles = [...new Set(
      planned
        .filter((p) => !p.error)
        .flatMap((p) => p.narrowing.scopes),
    )];

    log('canary: synthesising a guaranteed-failing test');
    const canary = await runCanaryGate({
      config, adapter, workspace: primary, command: config.baselineCommand, preferredFiles, scope: 'baseline',
    });
    report.gates.canary = {
      // NOT-ESTABLISHED is its own outcome, not PASSED: rendering it as PASSED
      // would claim, at the reporting layer, a property (the gate observing
      // failures) that was never established at the measuring layer -- exactly
      // the class of error this project exists to catch.
      outcome: canary.status === CanaryStatus.FAILED
        ? GateOutcome.FAILED
        : (canary.status === CanaryStatus.NOT_ESTABLISHED ? GateOutcome.NOT_ESTABLISHED : GateOutcome.PASSED),
      status: canary.status,
      grade: canary.grade,
      target: canary.target,
      // Every target tried and why it did not fire -- the evidence a reviewer
      // needs to tell "the harness is broken" from "that file is out of scope".
      attempts: canary.attempts ?? [],
      detail: canary.detail,
    };
    if (canary.status === CanaryStatus.FAILED) {
      log(`canary FAILED: ${canary.detail}`);
      return report;
    }
    log(`canary ${canary.status}${canary.target ? ` (via ${canary.target})` : ''}`);

    if (!mutants.length) {
      if (resultForEmptyCatalog) log('no mutants to run');
      report.noTrace = primary.assertNoTrace();
      return report;
    }

    // Every distinct narrow scope measured once, up front and unmutated.
    const narrowBaselines = createNarrowBaselineCache({ config, adapter, workspace: primary });
    for (const entry of planned) {
      if (entry.error) continue;
      await narrowBaselines.get(entry.narrowing.command);
    }
    log(`narrow baselines: ${narrowBaselines.size()} distinct scope(s)`);

    // ---- Phase B: apply, run, classify, restore ---------------------------
    report.results = await pool(planned, workspaces.length, async (entry, index) => {
      if (entry.error) return entry.error;
      return runMutant({
        ...entry,
        config,
        adapter,
        workspace: workspaces[index % workspaces.length],
        narrowBaselines,
      });
    });

    // Every result carries the run-level reproducibility, the same way `grade`
    // labels an exit-code kill as the weaker signal: a reader must be able to
    // tell a --allow-dirty verdict apart without cross-referencing the gates.
    report.results = report.results.map((result) => ({ ...result, reproducible: report.reproducible }));

    report.noTrace = primary.assertNoTrace();
    return report;
  } finally {
    for (const workspace of workspaces) workspace.dispose();
  }
}

// Site path set disagreements are surfaced rather than swallowed by the union, so
// a parser bug on a patch shape neither derivation handles shows up in the report
// instead of hiding behind the safe default.
export function collectPathSetMismatches(results) {
  const notes = [];
  for (const result of results ?? []) {
    for (const site of result.mutation ?? []) {
      if (site.kind !== 'patch' || !site.pathSet || site.pathSet.agree) continue;
      notes.push({
        id: result.id,
        onlyFromGit: site.pathSet.onlyFromGit,
        onlyFromParse: site.pathSet.onlyFromParse,
        explainedByRename: site.pathSet.mismatchExplainedByRename,
        snapshotted: site.pathSet.paths,
      });
    }
  }
  return notes;
}
