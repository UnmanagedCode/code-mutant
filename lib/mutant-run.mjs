// One mutant, start to finish: narrow-baseline check, snapshot, apply, measure,
// classify, restore.
//
// Split out of runner.mjs so that module is pool-and-wiring only. The split is
// also what makes the concurrency guards testable: two concurrent calls against
// one workspace can be driven directly from a test, rather than the guard being a
// branch no test can reach.
//
// Exceptions propagate deliberately. A rejected `applyResolved` or a failed
// `restoreAndVerify` must reject the caller's pool and abort the whole run -- a
// restore that did not put the tree back is not a per-mutant verdict, it is a
// reason to stop and have a human look at the tree.

import { applyResolved } from './apply.mjs';
import { Reason, Verdict, classify } from './classify.mjs';
import { CanaryStatus, runCanaryGate } from './gates.mjs';
import { measure } from './measure.mjs';
import { OccupancyError } from './occupancy.mjs';
import { captureSnapshot, restoreAndVerify, trackSnapshot, verifySnapshot } from './snapshot.mjs';
import { describeSites } from './sites.mjs';

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function delta(baselineCounts, mutantCounts) {
  if (!baselineCounts || !mutantCounts) return null;
  return {
    passed: mutantCounts.passed - baselineCounts.passed,
    failed: mutantCounts.failed - baselineCounts.failed,
    skipped: mutantCounts.skipped - baselineCounts.skipped,
  };
}

export function errorResult(mutant, reason, detail, extra = {}) {
  return {
    id: mutant.id,
    invariant: mutant.invariant,
    whyNotEquivalent: mutant.whyNotEquivalent ?? null,
    waived: mutant.waived ?? null,
    expectFail: mutant.expectFail ?? [],
    expectPass: mutant.expectPass ?? [],
    verdict: Verdict.ERROR,
    reason,
    detail,
    grade: null,
    narrowing: null,
    mutation: null,
    failedTests: [],
    unexpectedFailures: [],
    missingFailures: [],
    narrowBaseline: null,
    mutantCounts: null,
    delta: null,
    canary: null,
    durationMs: 0,
    // The three phases of a mutant's own cost, `null` for a phase that never ran.
    // An error result reaches here having run at most the narrow baseline, so all
    // three are null unless `extra` says otherwise.
    applyMs: null,
    measureMs: null,
    restoreMs: null,
    ...extra,
  };
}

// GUARD 2, in both of the places it has to be checked. At ENTRY it catches a
// workspace that was already contaminated before this mutant arrived; AFTER
// RESTORE it catches the mutant that did the contaminating, which the entry check
// alone would let report a verdict and make the NEXT mutant pay for it.
//
// After restore, not after the run: at that point this mutant's own sites are back
// to their pre-mutation bytes, so anything the ledger still flags is foreign.
function residueResult(mutant, occupancy, narrowing, resolvedSites, startedAt) {
  const residue = occupancy.residue();
  if (!residue.length) return null;
  return errorResult(
    mutant,
    Reason.WORKSPACE_RESIDUE,
    'this workspace carries mutation bytes from outside this mutant, so nothing measured in it is '
    + `interpretable -- a test that cannot even reach the mutated site can fail:\n${
      residue.map((d) => `  ${d.path}: ${d.reason}`).join('\n')}`,
    {
      narrowing: describeNarrowing(narrowing),
      mutation: describeSites(resolvedSites.resolved),
      durationMs: elapsedMs(startedAt),
    },
  );
}

function describeNarrowing(narrowing) {
  return {
    mode: narrowing.mode,
    command: narrowing.command,
    scopes: narrowing.scopes,
    requestedNames: narrowing.requestedNames,
    downgradeReason: narrowing.downgradeReason,
    placeholder: narrowing.placeholder,
  };
}

export async function runMutant({
  mutant, resolvedSites, narrowing, config, adapter, workspace, narrowBaselines, learn = false,
}) {
  // GUARD 1: exclusive occupancy. Taken before any measurement, so a workspace
  // shared by two mutants costs a verdict rather than producing a wrong one.
  let lease;
  try {
    lease = workspace.occupancy.claim(mutant.id);
  } catch (err) {
    if (!(err instanceof OccupancyError)) throw err;
    return errorResult(mutant, Reason.WORKSPACE_OCCUPIED, err.message, {
      narrowing: describeNarrowing(narrowing),
      mutation: describeSites(resolvedSites.resolved),
    });
  }
  try {
    return await measureMutant({
      mutant, resolvedSites, narrowing, config, adapter, workspace, narrowBaselines, learn,
    });
  } finally {
    lease.release();
  }
}

async function measureMutant({
  mutant, resolvedSites, narrowing, config, adapter, workspace, narrowBaselines, learn = false,
}) {
  const startedAt = process.hrtime.bigint();

  const dirtyOnArrival = residueResult(mutant, workspace.occupancy, narrowing, resolvedSites, startedAt);
  if (dirtyOnArrival) return dirtyOnArrival;

  const narrowBaseline = await narrowBaselines.get(narrowing.command);
  if (!narrowBaseline.green) {
    // Never SURVIVED: a scope that is already broken, or runs zero tests,
    // cannot say anything about a mutation applied inside it.
    const reason = narrowBaseline.parsed && narrowBaseline.parsed.ran === 0
      ? Reason.SCOPE_EMPTY
      : Reason.SCOPE_NON_GREEN;
    return errorResult(
      mutant,
      reason,
      `the narrowed scope is not usable: ${narrowBaseline.detail} (command: ${narrowing.command})`,
      {
        narrowing: describeNarrowing(narrowing),
        narrowBaseline: { command: narrowBaseline.command, green: false, counts: narrowBaseline.counts },
        mutation: describeSites(resolvedSites.resolved),
      },
    );
  }

  // Snapshot before applying, and track it before the first byte is written,
  // so an interrupt between the two is still covered.
  //
  // The three phases are timed separately because the whole point of the
  // breakdown is to tell "the harness is slow" from "the project's suite is
  // slow": apply and restore are the harness's own cost, measure is the
  // project's command.
  const phases = { applyMs: null, measureMs: null, restoreMs: null };
  const applyStartedAt = process.hrtime.bigint();
  const snapshot = trackSnapshot(captureSnapshot(workspace.root, resolvedSites.paths));
  workspace.occupancy.record(snapshot);
  let outcome;
  let intactDrift = [];
  try {
    applyResolved(workspace.root, resolvedSites.resolved);
    // The applied state, captured for comparison and DELIBERATELY NOT TRACKED:
    // the exit/signal guard must never be able to restore the tree TO a mutated
    // state. `snapshot` above remains the only tracked one.
    const applied = captureSnapshot(workspace.root, resolvedSites.paths);
    phases.applyMs = elapsedMs(applyStartedAt);
    const measureStartedAt = process.hrtime.bigint();
    outcome = await measure({ command: narrowing.command, config, adapter, workspace });
    phases.measureMs = elapsedMs(measureStartedAt);
    // GUARD 3: the mutation was intact for the whole measured run. If the site
    // bytes moved between apply and the command finishing, the command did not
    // measure what this result would claim it measured. This is the exact shape of
    // the false SURVIVED in card 2026-0029: another mutant's restore landed
    // mid-run and put the file back, so the suite went green with nothing applied.
    intactDrift = verifySnapshot(applied);
  } finally {
    const restoreStartedAt = process.hrtime.bigint();
    restoreAndVerify(snapshot);
    phases.restoreMs = elapsedMs(restoreStartedAt);
  }

  const contaminated = residueResult(mutant, workspace.occupancy, narrowing, resolvedSites, startedAt);
  if (contaminated) return { ...contaminated, ...phases };

  if (intactDrift.length) {
    return errorResult(
      mutant,
      Reason.MUTATION_NOT_INTACT,
      'the mutated bytes did not survive the measured run, so the command did not measure this mutation '
      + `(it must not read SURVIVED or KILLED):\n${intactDrift.map((d) => `  ${d.path}: ${d.reason}`).join('\n')}`,
      {
        narrowing: describeNarrowing(narrowing),
        mutation: describeSites(resolvedSites.resolved),
        narrowBaseline: {
          command: narrowBaseline.command, green: true, counts: narrowBaseline.counts,
        },
        mutantCounts: outcome.parsed ? {
          passed: outcome.parsed.passed,
          failed: outcome.parsed.failed,
          skipped: outcome.parsed.skipped,
          ran: outcome.parsed.ran,
        } : null,
        exitCode: outcome.run.exitCode,
        durationMs: elapsedMs(startedAt),
        ...phases,
      },
    );
  }

  let classification = outcome.hookFailure
    ? {
      verdict: Verdict.ERROR,
      reason: `${outcome.hookFailure.phase}-hook-failed`,
      detail: `the ${outcome.hookFailure.phase} hook failed (exit ${outcome.hookFailure.run.exitCode})`,
      grade: adapter.grade,
      failed: [],
      unexpectedFailures: [],
      missingFailures: [],
    }
    : classify({
      run: outcome.run,
      parsed: outcome.parsed,
      expectFail: mutant.expectFail,
      expectPass: mutant.expectPass,
      learn,
    });

  // In exit-code mode a SURVIVED verdict is the one that needs the canary:
  // a KILLED already proved the gate observes changes to this file, but a
  // SURVIVED is indistinguishable from "the gate never looked at this file at
  // all". So the canary is established lazily, exactly where it changes the
  // reading -- and a gate that cannot see a deliberate break turns the
  // survival into ERROR rather than a finding.
  let mutantCanary = null;
  if (adapter.grade === 'exit-code' && classification.verdict === Verdict.SURVIVED) {
    const siteFiles = resolvedSites.paths;
    mutantCanary = await runCanaryGate({
      config, adapter, workspace, command: narrowing.command, siteFiles, scope: 'mutant',
    });
    if (mutantCanary.status !== CanaryStatus.KILLED) {
      classification = {
        ...classification,
        verdict: Verdict.ERROR,
        reason: 'canary-not-established',
        detail: `this scope cannot be trusted to report a survivor: ${mutantCanary.detail}`,
      };
    }
  }

  const mutantCounts = outcome.parsed ? {
    passed: outcome.parsed.passed,
    failed: outcome.parsed.failed,
    skipped: outcome.parsed.skipped,
    ran: outcome.parsed.ran,
  } : null;

  return {
    id: mutant.id,
    invariant: mutant.invariant,
    whyNotEquivalent: mutant.whyNotEquivalent ?? null,
    waived: mutant.waived ?? null,
    expectFail: mutant.expectFail ?? [],
    expectPass: mutant.expectPass ?? [],
    verdict: classification.verdict,
    reason: classification.reason,
    detail: classification.detail,
    grade: classification.grade ?? adapter.grade,
    narrowing: describeNarrowing(narrowing),
    mutation: describeSites(resolvedSites.resolved),
    failedTests: classification.failed ?? [],
    unexpectedFailures: classification.unexpectedFailures ?? [],
    missingFailures: classification.missingFailures ?? [],
    narrowBaseline: {
      command: narrowBaseline.command,
      green: true,
      counts: narrowBaseline.counts,
    },
    mutantCounts,
    delta: delta(narrowBaseline.counts, mutantCounts),
    canary: mutantCanary,
    exitCode: outcome.run.exitCode,
    durationMs: elapsedMs(startedAt),
    ...phases,
  };
}
