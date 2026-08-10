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
import { captureSnapshot, restoreAndVerify, trackSnapshot } from './snapshot.mjs';
import { describeSites } from './sites.mjs';

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
    ...extra,
  };
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
  mutant, resolvedSites, narrowing, config, adapter, workspace, narrowBaselines,
}) {
  const startedAt = process.hrtime.bigint();

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
  const snapshot = trackSnapshot(captureSnapshot(workspace.root, resolvedSites.paths));
  let outcome;
  try {
    applyResolved(workspace.root, resolvedSites.resolved);
    outcome = await measure({ command: narrowing.command, config, adapter, workspace });
  } finally {
    restoreAndVerify(snapshot);
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
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  };
}
