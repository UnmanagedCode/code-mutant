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
import { Reason, Verdict, classify, isGraded } from './classify.mjs';
import { CanaryStatus, runCanaryGate } from './gates.mjs';
import { deadlineFor, measure } from './measure.mjs';
import { OccupancyError } from './occupancy.mjs';
import { captureSnapshot, restoreAndVerify, trackSnapshot, verifySnapshot } from './snapshot.mjs';
import { summarizeGroups } from './routing.mjs';
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
    // `null`, NEVER `[]`. This is the field the 2026-0183 phantom regressions
    // keyed on: an ERROR carrying `failedTests: []` is byte-identical to a
    // SURVIVED at the one place a consumer looks, so a classifier reading it
    // turned three ungraded results into three false findings. `[]` is reserved
    // for "nothing failed", which is a MEASUREMENT; `null` says "nothing is
    // nameable", which is the truth when no verdict was reached. Same rule the
    // baseline gate already follows (lib/gates.mjs).
    failedTests: null,
    unexpectedFailures: null,
    missingFailures: null,
    narrowBaseline: null,
    mutantCounts: null,
    delta: null,
    canary: null,
    durationMs: 0,
    deadlineMs: null,
    // Non-null ONLY when a command was killed at a deadline, and then it names
    // who to blame -- the single most useful thing this report can say about a
    // hang, because it decides whether the mutant gets rewritten or the project's
    // suite gets a defect report.
    hang: null,
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
    ...(narrowing.routes ? { routes: narrowing.routes } : {}),
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

  const narrowBaseline = await narrowBaselines.get(narrowing.command, narrowing.scopes);
  if (!narrowBaseline.green) {
    // Never SURVIVED: a scope that is already broken, or runs zero tests,
    // cannot say anything about a mutation applied inside it.
    //
    // The timeout branch is checked FIRST and gets its own reason, because a
    // killed run reports no counts and would otherwise be filed as
    // "scope-empty" -- a reader sent hunting for a coverage gap when the truth
    // is that the project's own unmutated suite does not terminate. And the
    // blame is `suite` with certainty: no mutation was applied yet.
    // Routed: one route that ran nothing is an empty scope too, even when
    // another route ran tests.
    const parsed = narrowBaseline.parsed;
    const empty = parsed && (parsed.ran === 0 || (parsed.groups ?? []).some((group) => group.parsed.ran === 0));
    const reason = narrowBaseline.timedOut
      ? Reason.SCOPE_TIMED_OUT
      : (empty ? Reason.SCOPE_EMPTY : Reason.SCOPE_NON_GREEN);
    return errorResult(
      mutant,
      reason,
      `the narrowed scope is not usable: ${narrowBaseline.detail} (command: ${narrowing.command})`,
      {
        narrowing: describeNarrowing(narrowing),
        narrowBaseline: { command: narrowBaseline.command, green: false, counts: narrowBaseline.counts },
        mutation: describeSites(resolvedSites.resolved),
        deadlineMs: config.timeoutMs,
        // A narrow baseline has no like-for-like reference of its own, so it runs
        // at the configured ceiling and `referenceMs` is null.
        hang: narrowBaseline.timedOut
          ? { blame: 'suite', deadlineMs: config.timeoutMs, referenceMs: null }
          : null,
      },
    );
  }

  // The mutant run's reference: THE SAME COMMAND, measured unmutated, moments
  // ago. Reaching this line required that run to be green, so the reference is
  // known to be a completed run of this exact scope -- which is what makes
  // blaming a timeout here on the mutation sound with no extra run.
  const deadlineMs = deadlineFor(config, narrowBaseline.durationMs);

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
    outcome = await measure({
      command: narrowing.command, config, adapter, workspace, deadlineMs,
    });
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
        deadlineMs,
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
      config,
      adapter,
      workspace,
      command: narrowing.command,
      siteFiles,
      scope: 'mutant',
      referenceMs: narrowBaseline.durationMs,
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
    // Ungraded results carry `null` here, never `[]` -- see errorResult above for
    // why that distinction is the whole of AC7. The graded path is unchanged.
    failedTests: isGraded(classification.verdict) ? (classification.failed ?? []) : null,
    unexpectedFailures: isGraded(classification.verdict) ? (classification.unexpectedFailures ?? []) : null,
    missingFailures: isGraded(classification.verdict) ? (classification.missingFailures ?? []) : null,
    narrowBaseline: {
      command: narrowBaseline.command,
      green: true,
      counts: narrowBaseline.counts,
    },
    mutantCounts,
    delta: delta(narrowBaseline.counts, mutantCounts),
    // Routed only: what each route the command ran reported.
    ...(outcome.parsed?.groups ? { groups: summarizeGroups(outcome.parsed.groups, { judged: false }) } : {}),
    canary: mutantCanary,
    exitCode: outcome.run.exitCode,
    durationMs: elapsedMs(startedAt),
    deadlineMs,
    // `mutation`, with certainty rather than by assumption: the narrow baseline
    // above ran the same command unmutated and completed green, so the only thing
    // that changed between a run that terminated and one that did not is the
    // mutation.
    hang: outcome.run.timedOut
      ? { blame: 'mutation', deadlineMs, referenceMs: narrowBaseline.durationMs }
      : null,
    ...phases,
  };
}
