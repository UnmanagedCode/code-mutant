// The printed matrix, the machine report, and the exit code.
//
// The exit code answers "are there survivors?" reliably, which a self-reported
// sentinel does not. It does NOT answer "should this block the merge?" -- that
// call stays the conductor's, made from the per-survivor evidence below.
//
// Every survivor block is written to be arbitrable WITHOUT READING PROJECT CODE,
// because the conductor decides which findings to relay and is not supposed to
// review the implementation itself. "The guard isn't covered" is not arbitrable;
// "test T claims to pin invariant I; mutating <anchor> -> <replacement> left
// 221/221 green, so T passes either way" is.

import { Verdict, isGraded } from './classify.mjs';
import { CANARY_NOT_ESTABLISHED, CANARY_SKIPPED } from './canary-gate.mjs';
import { CanaryStatus } from './gates.mjs';
import { GateOutcome, collectPathSetMismatches } from './runner.mjs';

export const SCHEMA_VERSION = 1;

export const ExitCode = {
  CLEAN: 0,
  SURVIVORS: 1,
  GATE_FAILED: 2,
  RESTORE_FAILED: 3,
  USAGE: 4,
  NO_VERDICT: 5,
  NO_HARNESS: 6,
};

export const EXIT_CODE_MEANINGS = [
  [ExitCode.CLEAN, 'no un-waived survivors, every mutant produced a verdict, gates passed'],
  [ExitCode.SURVIVORS, 'at least one UN-WAIVED survivor -- a coverage claim is false'],
  [ExitCode.GATE_FAILED, 'a trust gate failed; no verdict is interpretable'],
  [ExitCode.RESTORE_FAILED, 'restore or the clean-tree assertion failed -- inspect the tree by hand'],
  [ExitCode.USAGE, 'usage, config, or catalog error'],
  [ExitCode.NO_VERDICT, 'no survivors, but some mutant produced no verdict (ERROR/TIMEOUT) -- not a clean proof'],
  [ExitCode.NO_HARNESS, 'this project is not configured for mutation testing -- nothing ran, nothing is claimed; NOT an error'],
];

// WHEN "THE GATES DOMINATED THIS RUN" IS ACTIONABLE, in multiples of the
// measurement they bought.
//
// Deliberately NOT "gatesMs is a large share of totalMs": a share threshold either
// fires on the optimal run or misses the pathological one, because the gates
// dominate a well-batched run's wall time too -- and a note that fires on a run
// with no remedy left teaches the reader to skip it. (Pre-narrowing, the batched
// shape was ~76%: two whole-suite gate runs against ~40 s of measurement for 35
// mutants. The rows below carry the post-narrowing figures.)
//
// The discriminating quantity is FIXED gate cost (fixedGateMs below, not the whole
// bucket) per unit of MEASUREMENT, because putting k mutants in one invocation
// divides it by k while leaving the fixed cost untouched. gatesMs itself is NOT
// untouched -- more narrow-eligible mutants means more narrow canary runs.
//
//   field data, 35-mutant catalog, `npm test` ~67 s (prover session f99553e4).
//   MEASURED, before the canary was narrowed (card 2026-0048), so that run's
//   canary really was a whole `baselineCommand` run and all of gatesMs was fixed:
//     1 mutant per invocation, canary scope `baseline`:
//       135 100 / (1 000 + 1 150) = 62.8x  -> fires
//   HYPOTHETICAL, the same 35 in one invocation. A run that narrows resolves its
//   canary to `narrow` scope, which is variable cost, so only the baseline is
//   fixed:
//     35 in one invocation, canary scope `narrow`:
//       ~67 500 / (1 000 + 40 250) = ~1.6x  -> silent (and silent on headroom too)
//
// 10x sits ~6x either side. Documented in README under "Where a run's wall time
// went"; this constant is its only home.
const FIXED_COST_DOMINANCE_RATIO = 10;

const VERDICT_ORDER = [
  Verdict.SURVIVED, Verdict.IMPRECISE, Verdict.ERROR, Verdict.TIMEOUT, Verdict.KILLED, Verdict.LEARNED,
];

export function partition(results) {
  const open = results.filter((r) => !r.waived);
  const waived = results.filter((r) => r.waived);
  return {
    open,
    waived,
    survivors: open.filter((r) => r.verdict === Verdict.SURVIVED),
    waivedSurvivors: waived.filter((r) => r.verdict === Verdict.SURVIVED),
    // A catalog whose mutants all ERROR would otherwise read "0 survivors" and
    // exit clean, which is a false proof rather than a clean one.
    noVerdict: open.filter((r) => r.verdict === Verdict.ERROR || r.verdict === Verdict.TIMEOUT),
  };
}

export function exitCodeFor(report) {
  if (report.gates?.inPlaceLock?.outcome === GateOutcome.FAILED) return ExitCode.GATE_FAILED;
  if (report.gates?.cleanTree?.outcome === GateOutcome.FAILED) return ExitCode.GATE_FAILED;
  if (report.gates?.baseDiff?.outcome === GateOutcome.FAILED) return ExitCode.GATE_FAILED;
  if (report.gates?.baseline?.outcome === GateOutcome.FAILED) return ExitCode.GATE_FAILED;
  if (report.gates?.canary?.outcome === GateOutcome.FAILED) return ExitCode.GATE_FAILED;
  if (report.noTrace && report.noTrace.ok === false) return ExitCode.RESTORE_FAILED;
  const { survivors, noVerdict } = partition(report.results ?? []);
  if (survivors.length) return ExitCode.SURVIVORS;
  if (noVerdict.length) return ExitCode.NO_VERDICT;
  return ExitCode.CLEAN;
}

function counts(value) {
  if (!value) return '-';
  return `${value.passed}/${value.failed}/${value.skipped}`;
}

function deltaText(value) {
  if (!value) return '-';
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  return `${sign(value.passed)}/${sign(value.failed)}/${sign(value.skipped)}`;
}

function truncate(text, width) {
  const value = String(text ?? '');
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;
}

function renderTable(headers, rows) {
  if (!rows.length) return '  (none)';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => `  ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')}`.trimEnd();
  return [
    line(headers),
    `  ${widths.map((w) => '-'.repeat(w)).join('-+-')}`,
    ...rows.map(line),
  ].join('\n');
}

// Milliseconds as an integer cell. `-` for a bucket that is absent or non-finite,
// never `undefined` printed into a table -- a reader cannot tell that apart from
// a real zero.
function msCell(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '-';
}

// A share of a zero or missing total is undefined, so it renders `-` rather than
// `0.0%` (which reads as a measurement that rounded down) or `NaN%`. A share ABOVE
// 100% is printed as-is: mutantsMs is a sum of per-mutant wall clocks and
// legitimately exceeds totalMs under jobs > 1, and clamping would be a lie.
function shareCell(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '-';
  return `${((part / total) * 100).toFixed(1)}%`;
}

// The measurement the gates bought: everything whose cost SCALES with how many
// mutants rode along. The denominator of the ratio above.
//
// `null` -- never a coerced 0 -- when either bucket is absent or non-finite. A
// missing bucket read as 0 makes the ratio infinite, which fires the note on
// incomplete data and makes it cite "0 ms of measurement" while the table
// directly above renders that same bucket as `-`.
function measuredMs(timings) {
  if (!Number.isFinite(timings.narrowBaselinesMs) || !Number.isFinite(timings.mutantsMs)) return null;
  return timings.narrowBaselinesMs + timings.mutantsMs;
}

// THE PART OF gatesMs THAT IS ACTUALLY FIXED PER INVOCATION -- the only cost more
// mutants per invocation can amortise, and therefore the honest numerator.
//
// `gatesMs` is not all fixed cost. A canary at `scope: "narrow"` is one run per
// DISTINCT narrowing command (mutants.schema.md, "The canary's scope"), so its
// cost scales with the mutants in the run: batching more mutants ADDS narrow
// canary runs rather than spreading them. At `scope: "baseline"` the canary IS a
// whole `baselineCommand` run -- fixed, and re-paid every invocation. At
// `"mixed"` the baseline half is fixed and `scopes[]` holds the narrow remainder.
//
// This is what makes the half-hit read correctly without a special case. Once the
// gate cache has served the full-suite baseline, a narrowing run's remaining gate
// cost is entirely variable, so nothing is left for `run --all` to spread and the
// note falls silent on its own. But a `run` that reached BASELINE canary scope
// (nothing narrow-canary-eligible) really did re-pay a whole suite, and still
// fires -- suppressing on `baseline.fromCache` alone would have hidden exactly
// the pathology this note exists for.
function fixedGateMs(report) {
  const baseline = report.gates?.baseline;
  const canary = report.gates?.canary;
  const fixed = Number.isFinite(baseline?.durationMs) ? baseline.durationMs : 0;
  if (!canary || !Number.isFinite(canary.durationMs)) return fixed;
  // An unrecognised or absent scope contributes nothing, the same way an absent
  // bucket does: silence on data this cannot read beats a guess about it.
  if (canary.scope === 'baseline') return fixed + canary.durationMs;
  if (canary.scope !== 'mixed') return fixed;
  // A scope entry whose duration cannot be read makes the narrow half unknowable,
  // and understating the narrow half OVERSTATES the fixed numerator -- the one
  // direction every other unknown in here refuses to guess in.
  const scopes = canary.scopes ?? [];
  if (scopes.some((scope) => !Number.isFinite(scope.durationMs))) return fixed;
  const narrowHalf = scopes.reduce((sum, scope) => sum + scope.durationMs, 0);
  return fixed + Math.max(0, canary.durationMs - narrowHalf);
}

// Fires only when BOTH hold: the gates dominated what they bought, AND the catalog
// still holds mutants this invocation did not carry.
//
// The second conjunct is what keeps the note off an already-amortised run
// STRUCTURALLY rather than by tuning a threshold -- a run that carried the whole
// catalog has spent the operator's only lever, so there is nothing the note could
// ask for. `selection` is set by commandRun alone: `probe` (one ad-hoc mutation by
// design), `baseline`, and every hand-built report have none, and absent is
// treated as UNSATISFIED rather than guessed. A missed note costs nothing; a false
// one teaches the reader to skip the real one.
//
// KNOWN QUIET CASE, deliberate: a resumed subset run inflates mutantsMs, because a
// reused result spreads `...journalled` and carries the EARLIER invocation's
// durationMs (lib/runner.mjs, reusedEntries). That drives the ratio down and this
// stays silent even though the gates really were re-paid. Accepted so the note's
// arithmetic is always checkable against the buckets printed directly above it --
// a predicate reading numbers that do not appear in the table is worse than one
// that occasionally says nothing, and the RESUMED banner already reports that the
// gates ran in full.
function fixedCostDominates(report) {
  const timings = report.timings;
  if (!timings) return false;
  // A failed gate stopped the run before any mutant, and `baseline` carries none.
  // Neither is a batching problem.
  if (!(report.results ?? []).length) return false;
  const { catalogTotal, selected } = report.selection ?? {};
  if (!Number.isFinite(catalogTotal) || !Number.isFinite(selected)) return false;
  if (selected >= catalogTotal) return false;
  const measured = measuredMs(timings);
  // No denominator, no ratio. Covers an absent bucket and a real zero alike.
  if (measured === null || measured <= 0) return false;
  // 0 when no gate command ran here (in practice: both served from cache), and
  // 0 when what ran was entirely narrow-scope work that batching cannot spread.
  return fixedGateMs(report) >= FIXED_COST_DOMINANCE_RATIO * measured;
}

// Where this run's wall time went, and -- only when the numbers say there is a
// move left -- the one remedy that changes them.
function costLines(report) {
  const timings = report.timings;
  if (!timings) return [];

  const lines = [`Cost  [totalMs ${msCell(timings.totalMs)}]`];
  lines.push(renderTable(['bucket', 'ms', 'share of totalMs'], [
    ['gatesMs', msCell(timings.gatesMs), shareCell(timings.gatesMs, timings.totalMs)],
    ['narrowBaselinesMs', msCell(timings.narrowBaselinesMs), shareCell(timings.narrowBaselinesMs, timings.totalMs)],
    ['mutantsMs', msCell(timings.mutantsMs), shareCell(timings.mutantsMs, timings.totalMs)],
  ]));
  // Labelled where it is printed, not only in the docs: this is the number a
  // reader misattributes to "the suite is too slow", and docs do not reach them at
  // the moment they are staring at it. When only PART of gatesMs is fixed, the
  // fixed part is named -- both because calling the whole bucket fixed would be
  // false on a narrowing run, and because it is the note's numerator.
  const fixed = fixedGateMs(report);
  const scaling = 'a narrow canary is one run per scope, which scales with the mutants in the run '
    + 'rather than being spread by them';
  // Four cases, because three of them printed a claim that contradicted the line
  // below: a fully cached run has NO fixed cost, and saying "gatesMs is FIXED per
  // invocation" above "gatesMs is 0 ... re-paid no fixed cost" told the reader
  // both at once. An absent gatesMs is characterised not at all rather than
  // described as fixed.
  if (!Number.isFinite(timings.gatesMs)) {
    // Nothing to say about a bucket the table already renders as `-`.
  } else if (timings.gatesMs <= 0) {
    lines.push('  No gate command ran here, so no fixed per-invocation cost was re-paid.');
  } else if (fixed <= 0) {
    // States the RULE and the conclusion, not which non-fixed shape ran: `narrow`
    // scope is one case, but so is a scope this cannot read, and naming the narrow
    // canary there would be a guess dressed as a finding.
    lines.push('  NONE of gatesMs counts as fixed per invocation, so nothing here is cost that more '
      + `mutants per invocation would spread. Only a whole-suite gate run is fixed; ${scaling}.`);
  } else if (fixed < timings.gatesMs) {
    lines.push(`  Of gatesMs, ${msCell(fixed)} ms is FIXED per invocation -- the same cost whether the run `
      + `carries 1 mutant or 35. As for the rest, ${scaling}.`);
  } else {
    lines.push('  gatesMs is FIXED per invocation -- the same cost whether the run carries 1 mutant or 35.');
  }

  const baselineCached = report.gates?.baseline?.fromCache === true;
  const canaryCached = report.gates?.canary?.fromCache === true;
  if (baselineCached && canaryCached) {
    lines.push('  gatesMs is 0 because both gates were served from the gate cache -- this invocation '
      + 're-paid no fixed cost; the original measurement is at gates.*.measuredDurationMs.');
  } else if (baselineCached && report.gates?.canary?.skipped !== CANARY_SKIPPED) {
    // The normal shape of a narrowing run, since a narrow canary is never cached.
    // Without this the reader cannot tell a served baseline from a project whose
    // whole suite really costs what one narrow run does. Not for a skipped canary,
    // which cost nothing either: "No gate command ran here" above already says so.
    lines.push('  gatesMs covers the canary only -- the baseline was served from the gate cache and '
      + 'cost nothing here.');
  }

  if (Number.isFinite(timings.mutantsMs) && Number.isFinite(timings.totalMs)
    && timings.totalMs > 0 && timings.mutantsMs > timings.totalMs) {
    // The concurrency is named only when the report actually carries it: `jobs
    // undefined` in the one output a human reads is worse than no attribution.
    const atJobs = Number.isFinite(report.jobs) ? ` at jobs ${report.jobs}` : '';
    lines.push('  mutantsMs is a sum of per-mutant wall clocks, so above 100% is the correct reading'
      + `${atJobs} -- not a rounding error.`);
  }

  if (fixedCostDominates(report)) {
    // `measured` is finite and > 0 here, and `fixed` is the same number the label
    // line above printed -- so every figure in this note is checkable against what
    // the reader can already see.
    const measured = measuredMs(timings);
    // Stated as fact with the operator's own numbers, and the remedy made
    // CONDITIONAL: re-running one mutant to confirm a fix, or re-running last
    // round's survivors, is a legitimate deliberate subset run where there may be
    // nothing left to batch. This is a diagnostic, not a reprimand.
    lines.push(`  FIXED COST DOMINATES -- ${msCell(fixed)} ms of fixed gate cost bought `
      + `${msCell(measured)} ms of measurement (${(fixed / measured).toFixed(1)}x). This invocation `
      + `carried ${report.selection.selected} of ${report.selection.catalogTotal} catalog mutant(s), `
      + 'and that fixed cost is the same for all of them as for one.');
    lines.push('    If you have more of the catalog to run, one `mutate.mjs run --all` invocation pays '
      + 'these gates once instead of once per mutant. (Threshold: fixed gate cost >= '
      + `${FIXED_COST_DOMINANCE_RATIO}x measured cost with catalog mutants un-run; see README `
      + '"Where a run\'s wall time went".)');
  }
  return lines;
}

function matrixRows(results, learn = false) {
  return [...results]
    .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict))
    .map((r) => [
      r.id,
      truncate(r.invariant, 44),
      r.verdict,
      // The grade label is a column of its own: an exit-code kill must never be
      // read as though precision had been established.
      r.grade ?? '-',
      // Same treatment as grade: a --allow-dirty verdict must never be read as
      // though it were re-runnable against a committed sha.
      r.reproducible === false ? 'NO (dirty)' : 'yes',
      // In learn mode expectFail/expectPass are scope hints, not a claim, so this
      // column renders the scope the run actually resolved -- never r.expectFail,
      // which would read like a claim that was graded.
      learn
        ? truncate((r.narrowing?.scopes ?? []).join(', ') || '(whole suite)', 30)
        : truncate((r.expectFail ?? []).join(', ') || '-', 30),
      // `not graded`, never `(none)`: `(none)` is what a SURVIVED row shows, and
      // rendering an ungraded row the same way is the printed-output half of the
      // shape confusion that produced the 2026-0183 phantom regressions.
      isGraded(r.verdict) ? truncate((r.failedTests ?? []).join(', ') || '(none)', 30) : 'not graded',
      counts(r.narrowBaseline?.counts),
      counts(r.mutantCounts),
      deltaText(r.delta),
    ]);
}

function matrixHeaders(learn = false) {
  return [
    'id', 'invariant', 'verdict', 'grade', 'repro', learn ? 'scope' : 'expected', learn ? 'observed' : 'actual',
    'base p/f/s', 'mutant p/f/s', 'Δ',
  ];
}

// A scope that was attempted and observed its injected canary. `skipped` scopes
// have no status at all, which is not the same as one that ran and did not fire.
function scopeFired(scope) {
  return !scope.skipped && scope.status === CanaryStatus.KILLED;
}

// Routed: the canary must fire in every route a command runs, so each route's
// own outcome is shown -- the one that did not fire is the one to fix.
function routeCanaryLines(routes, indent) {
  return (routes ?? []).map((route) => (route.status === CanaryStatus.KILLED
    ? `${indent}- ${route.route} KILLED via ${route.target}`
    : `${indent}- ${route.route} ${route.status === CanaryStatus.FAILED ? 'NOT FIRED' : route.status}  ${route.detail}`));
}

function gateLines(report) {
  const lines = ['Trust gates'];
  // First, because it is checked first: a refusal here happened before the tree
  // was read at all, so a reader must not go looking for a dirty-tree cause.
  const inPlaceLock = report.gates?.inPlaceLock;
  const cleanTree = report.gates?.cleanTree;
  const baseDiff = report.gates?.baseDiff;
  const baseline = report.gates?.baseline;
  const canary = report.gates?.canary;
  if (inPlaceLock) {
    lines.push(`  in-place-lock  ${inPlaceLock.outcome.toUpperCase()}  ${inPlaceLock.detail}`);
  }
  if (cleanTree) {
    lines.push(`  clean-tree  ${cleanTree.outcome.toUpperCase()}  ${cleanTree.detail}`);
  }
  if (baseDiff) {
    lines.push(`  base-diff   ${baseDiff.outcome.toUpperCase()}${baseDiff.base ? `  vs ${baseDiff.base}` : ''}  ${baseDiff.detail}`);
  }
  // Suffixed per gate as well as bannered at the top, so a reader scanning only
  // the gate block cannot mistake a served measurement for one made here.
  const served = (gate) => (gate.fromCache ? '   [served from cache, not measured here]' : '');
  if (baseline) {
    lines.push(`  baseline  ${baseline.outcome.toUpperCase()}  ${counts(baseline.counts)} (p/f/s)  ${baseline.detail}${served(baseline)}`);
    // Routed: each route is gated on its own, so each gets its own line.
    for (const group of baseline.groups ?? []) {
      lines.push(`            - ${group.route}  ${group.green ? 'green' : 'NOT GREEN'}  ${counts(group.counts)} (p/f/s), `
        + `exit ${group.exitCode}${group.detail ? `  ${group.detail}` : ''}`);
    }
  }
  if (canary) {
    // The SCOPE beside the grade, on the gate line itself: a canary record no
    // longer necessarily attests about `baselineCommand`, and a reader deciding
    // whether to believe a verdict has to know which command was attested.
    const scope = canary.scope ? `${canary.grade} grade, ${canary.scope} scope` : `${canary.grade} grade`;
    const scopes = canary.scopes ?? [];
    const attempted = scopes.filter((s) => !s.skipped);
    const summary = attempted.length
      ? `  ${attempted.filter(scopeFired).length} of ${attempted.length} scope(s) attested`
      : '';
    lines.push(`  canary    ${canary.status}  [${scope}]${canary.target ? `  via ${canary.target}` : ''}${summary}${served(canary)}`);
    lines.push(`            ${canary.detail}`);
    lines.push(...routeCanaryLines(canary.routes, '            '));
    // One line per judging command, so "which scope is untrustworthy" is legible
    // without opening --json -- and so a PARTIAL can never look like a pass.
    for (const one of scopes) {
      const state = one.skipped ? 'NOT ATTEMPTED' : (scopeFired(one) ? 'KILLED' : 'NOT FIRED');
      const why = scopeFired(one) ? `via ${one.target}` : one.detail;
      lines.push(`            - ${one.command}   ${state}  ${why}`);
      lines.push(...routeCanaryLines(one.routes, '                '));
      if (!one.skipped && !scopeFired(one) && one.mutants?.length) {
        lines.push(`              mutants refused: ${one.mutants.join(', ')}`);
      }
    }
  }
  return lines;
}

// Which runners judged a survivor: a route with no ref in scope never ran, so
// it could not have caught the mutation, and the reader must see that.
function routesRunLine(result, routes) {
  if (!routes?.length || !result.narrowing?.routes) return null;
  const ran = result.narrowing.routes;
  const idle = routes.map((route) => route.name).filter((name) => !ran.includes(name));
  return `     routes run:   ${ran.join(', ')}${idle.length ? ` (${idle.map((name) => `${name}: no ref in scope`).join(', ')})` : ''}`;
}

function survivorBlock(result, index, learn = false, routes = null) {
  const mutation = (result.mutation ?? []).map((site) => {
    if (site.kind === 'patch') {
      return `      patch touching ${site.paths.join(', ')}`;
    }
    return site.edits.map((edit) => (
      `      ${site.file}:${edit.line}\n`
      + `        ${JSON.stringify(edit.anchor)}\n`
      + `          -> ${JSON.stringify(edit.replacement)}`
    )).join('\n');
  }).join('\n');

  return [
    `  ${index + 1}. ${result.id} -- ${result.invariant}`,
    learn
      ? '     observed:     no test failed -- nothing in this scope covers this mutation'
      : `     claim:        ${(result.expectFail ?? []).join(', ') || '(no expectFail listed)'} should have failed`,
    `     mutation applied:`,
    mutation,
    `     why not equivalent: ${result.whyNotEquivalent ?? '(not stated)'}`,
    `     verdict:      SURVIVED  [${result.grade} grade]`,
    `     scope:        ${result.narrowing?.command ?? '-'}`,
    routesRunLine(result, routes),
    `     baseline:     ${counts(result.narrowBaseline?.counts)} (p/f/s) in the same scope`,
    `     with mutant:  ${counts(result.mutantCounts)} (p/f/s), exit ${result.exitCode ?? '-'}`,
    `     reading:      ${result.detail}`,
    result.waived ? `     WAIVED:       ${result.waived.reason}` : null,
  ].filter(Boolean).join('\n');
}

export function formatReport(report) {
  const lines = [];
  const { open, waived, survivors, waivedSurvivors, noVerdict } = partition(report.results ?? []);

  lines.push(`code-mutant  ${report.command ?? 'run'}  [isolation: ${report.isolation}, jobs: ${report.jobs}, adapter: ${report.adapter?.name} (${report.adapter?.grade} grade)]`);
  if (report.adapter?.routes) {
    lines.push(`  routes: ${report.adapter.routes.map((route) => `${route.name}=${route.runner} [${route.tests.join(', ')}]`).join('; ')}`);
  }
  lines.push(`  sha: ${report.mutatedSha ?? '(unknown)'}${report.reproducible === false ? '  -- NON-REPRODUCIBLE (--allow-dirty)' : ''}`);
  if (report.learn) {
    lines.push('  LEARN MODE -- nothing was graded. expectFail/expectPass picked the scope only; the '
      + '"observed" column is what actually failed, not a verdict against a claim.');
  }
  // Named at the top, the same way LEARN MODE is: a reused verdict was produced by
  // an EARLIER process, and whoever reads a puzzling result must not take it for
  // one this invocation measured.
  //
  // The gate clause is CONDITIONAL on the cache, and that is the whole reason it
  // is: a resumed run against a warm cache would otherwise print "every gate ran
  // in full" immediately beside the GATES FROM CACHE banner below -- two adjacent
  // sentences contradicting each other, in the report a puzzled reader opens
  // first. Resume itself still never reuses a gate; the cache is a separate
  // decision with a separate key.
  // BOTH halves, never `status === 'hit'` alone: a hit serves the baseline
  // always and the canary only when the entry carries one, so keying on the
  // status would print "the gates were served" directly above a canary that ran
  // in this invocation.
  const cacheHit = report.gateCache?.status === 'hit';
  const canaryServed = cacheHit && report.gateCache.canaryServed === true;
  const gatesServed = cacheHit && canaryServed;
  const baselineOnlyServed = cacheHit && !canaryServed;
  if (report.resumed && report.resumed.reused > 0) {
    const gateClause = gatesServed
      ? 'The gates above were served from the gate cache (see below), not measured here; resume itself '
        + 'reused only per-mutant measurement.'
      : (baselineOnlyServed
        ? 'The baseline above was served from the gate cache (see below) and the canary was measured '
          + 'here; resume itself reused only per-mutant measurement.'
        : 'Every gate above ran in full this invocation; only per-mutant measurement was reused.');
    lines.push(`  RESUMED -- ${report.resumed.reused} verdict(s) reused from a previous run's journal, `
      + `${report.resumed.ran} measured here. ${gateClause}`);
  }
  const canarySkipped = report.gates?.canary?.skipped === CANARY_SKIPPED;
  if (gatesServed) {
    // Two timestamps once a later hit filled an empty canary slot: the canary was
    // not measured when the baseline was, and saying so is the only reason the
    // entry records `canaryMeasuredAt` at all.
    const { measuredAt, canaryMeasuredAt } = report.gateCache;
    const when = canaryMeasuredAt && canaryMeasuredAt !== measuredAt
      ? `the baseline was measured ${measuredAt} and the canary ${canaryMeasuredAt}`
      : `baseline and canary were measured ${measuredAt}`;
    lines.push(`  GATES FROM CACHE -- ${when} against `
      + `a byte-identical tree (key ${report.gateCache.key}, sha ${report.gateCache.measuredSha ?? '(unknown)'}). `
      + 'This invocation measured neither. --remeasure-gates forces a fresh measurement.');
  } else if (baselineOnlyServed) {
    lines.push(`  BASELINE FROM CACHE -- the baseline was measured ${report.gateCache.measuredAt} against a `
      + `byte-identical tree (key ${report.gateCache.key}, sha ${report.gateCache.measuredSha ?? '(unknown)'}). `
      + (canarySkipped
        ? 'No canary was measured here (--no-canary). --remeasure-gates forces a fresh baseline measurement too.'
        : 'The canary was measured HERE: a narrow-scope canary is never cached, and an entry from '
          + '`baseline --no-canary` carries none. --remeasure-gates forces a fresh baseline measurement too.'));
  }
  // Beside CANARY PARTIAL, for the same reason: a reader skimming for KILLED must
  // not read the absence of a canary as one that passed.
  if (canarySkipped) {
    lines.push('  CANARY SKIPPED -- --no-canary: this invocation established no canary, so nothing here shows the '
      + 'test command observes a failure. Every graded `run` establishes its own canary at the scope it grades.');
  }
  // A TOP-LEVEL BANNER, beside LEARN MODE, because a partial gate is the one
  // state a reader skimming the gate block could take for a pass: some mutants
  // below were judged and some were refused outright.
  if (report.gates?.canary?.outcome === GateOutcome.PARTIAL) {
    const scopes = (report.gates.canary.scopes ?? []).filter((s) => !s.skipped);
    const unattested = scopes.filter((s) => !scopeFired(s)).length;
    const refused = (report.results ?? []).filter((r) => r.reason === CANARY_NOT_ESTABLISHED).length;
    lines.push(`  CANARY PARTIAL -- ${unattested} of ${scopes.length} narrowed scope(s) could not be shown `
      + `to observe a failure. ${refused} mutant(s) were ERRORed with canary-not-established rather than `
      + 'judged by an unattested command.');
  }
  // Each worker owns one copy exclusively (asserted, see lib/occupancy.mjs), so
  // what jobs>1 can still break is the PROJECT'S suite, not the runner. Named on
  // the report and not only at config load, because whoever reads a puzzling
  // verdict is reading this, not the warning that scrolled past.
  if (report.jobs > 1) {
    lines.push(`  jobs: ${report.jobs} -- your suite ran ${report.jobs}x concurrently, in ${report.jobs} copies. `
      + 'Unsafe for a suite with a fixed port, a fixed temp/data dir, a shared DB or in-place fixture, a '
      + 'shared write cache, or absolute-path dependence; "preserve" paths are symlinked, so shared.');
  }
  lines.push('');
  lines.push(...gateLines(report));

  // Before the gate-failure early return below, deliberately: a failed gate's cost
  // is part of what a run costs (which is why deriveTimings wraps every early
  // return), and that is the run whose cost is most likely to have been wasted.
  const cost = costLines(report);
  if (cost.length) {
    lines.push('');
    lines.push(...cost);
  }

  if (report.gates?.inPlaceLock?.outcome === GateOutcome.FAILED
    || report.gates?.cleanTree?.outcome === GateOutcome.FAILED
    || report.gates?.baseDiff?.outcome === GateOutcome.FAILED
    || report.gates?.baseline?.outcome === GateOutcome.FAILED
    || report.gates?.canary?.outcome === GateOutcome.FAILED) {
    lines.push('');
    lines.push('THE HARNESS IS NOT TRUSTWORTHY FOR THIS RUN. No verdict below (if any) is interpretable.');
    lines.push('Report this upward rather than reporting a clean sweep.');
    return lines.join('\n');
  }

  if (open.length) {
    lines.push('');
    lines.push('Matrix (survivors first)');
    lines.push(renderTable(matrixHeaders(report.learn), matrixRows(open, report.learn)));
  }

  if (waived.length) {
    lines.push('');
    lines.push('Waived (a recorded conductor decision; still run, reported separately)');
    lines.push(renderTable([...matrixHeaders(report.learn), 'reason'], matrixRows(waived, report.learn).map((row, i) => [
      ...row, truncate(waived[i].waived?.reason, 40),
    ])));
  }

  if (survivors.length) {
    lines.push('');
    lines.push(`Survivors -- ${survivors.length} blocking finding(s), arbitrable without reading project code`);
    lines.push(survivors.map((r, i) => survivorBlock(r, i, report.learn, report.adapter?.routes)).join('\n\n'));
  }

  if (waivedSurvivors.length) {
    lines.push('');
    lines.push(`Waived survivors -- ${waivedSurvivors.length} (not counted as open findings)`);
    lines.push(waivedSurvivors.map((r, i) => survivorBlock(r, i, report.learn, report.adapter?.routes)).join('\n\n'));
  }

  // Which rows, by id -- the banner gives the count, this gives the identities, so
  // a reader can tell any individual verdict apart without opening the JSON.
  const reused = (report.results ?? []).filter((r) => r.fromJournal);
  if (reused.length) {
    lines.push('');
    lines.push('Reused from the journal (not measured this invocation):');
    for (const r of reused) lines.push(`  ${r.id}  ${r.verdict}`);
  }

  const narrowedByName = open.filter((r) => r.narrowing?.mode === 'names');
  if (narrowedByName.length) {
    lines.push('');
    lines.push('Narrowing note: these mutants ran name-level narrowing, so a failure in a test that is in');
    lines.push('neither expectFail nor expectPass could not be observed -- IMPRECISE detection was limited');
    lines.push('to the expectPass set for them:');
    for (const r of narrowedByName) lines.push(`  ${r.id}  ${r.narrowing.command}`);
  }

  const downgraded = open.filter((r) => r.narrowing?.requestedNames && r.narrowing?.mode !== 'names');
  for (const r of downgraded) {
    lines.push('');
    lines.push(`Narrowing note: ${r.id} asked for name-level narrowing but ran at ${r.narrowing.mode} granularity -- ${r.narrowing.downgradeReason}`);
  }

  const mismatches = collectPathSetMismatches(report.results);
  if (mismatches.length) {
    lines.push('');
    lines.push('Patch path-set derivations disagreed (the UNION was snapshotted, so nothing was under-covered):');
    for (const note of mismatches) {
      lines.push(`  ${note.id}: only from git=${note.onlyFromGit.join(', ') || '-'}, only from diff parse=${note.onlyFromParse.join(', ') || '-'}`
        + `${note.explainedByRename ? ' (expected: git apply --numstat omits a rename source)' : ' -- NOT explained by a rename, worth a look'}`);
    }
  }

  // Blame first, and separately, because it is the one thing that decides what
  // happens next: `suite` is a project defect to route upward and rewriting the
  // mutant cannot fix it, `mutation` is a mutant to rewrite smaller. The generic
  // list below still carries every ungraded row, so nothing is only here.
  const hangs = noVerdict.filter((r) => r.hang);
  if (hangs.length) {
    lines.push('');
    lines.push(`Hangs -- ${hangs.length} not graded. Read the blame column before deciding what to fix:`);
    lines.push(renderTable(
      ['id', 'verdict', 'blame', 'killed at', 'same scope unmutated'],
      hangs.map((r) => [
        r.id,
        r.verdict,
        r.hang.blame,
        `${Math.round(r.hang.deadlineMs)}ms`,
        r.hang.referenceMs === null ? '(not measured)' : `${Math.round(r.hang.referenceMs)}ms`,
      ]),
    ));
    lines.push('  blame=suite: the UNMUTATED scope did not terminate -- a project defect, not a mutant to rewrite.');
    lines.push('  blame=mutation: the same scope completed unmutated, so the mutation hung it -- rewrite it smaller.');
  }

  if (noVerdict.length) {
    lines.push('');
    lines.push(`No verdict from ${noVerdict.length} mutant(s) -- a harness or catalog problem, not a coverage finding:`);
    for (const r of noVerdict) lines.push(`  ${r.id}  ${r.verdict}  ${r.reason ?? ''}  ${r.detail}`);
  }

  if (report.noTrace) {
    lines.push('');
    if (report.noTrace.ok) {
      lines.push(report.isolation === 'copy'
        ? 'No trace: copy discarded; the real tree was never touched.'
        : 'No trace: `git status --porcelain` is byte-identical to before the run.');
    } else {
      lines.push('NO-TRACE ASSERTION FAILED -- the tree is NOT as it was before this run.');
      // Copy mode has no before/after status to show: what it can show is which
      // paths still carry mutation bytes, and in which copy. Every mutant that ran
      // in that copy after the residue appeared measured against it.
      if (report.noTrace.residue?.length) {
        lines.push('  mutation bytes left behind:');
        for (const r of report.noTrace.residue) lines.push(`    ${r.workspace ?? ''} ${r.path}: ${r.reason}`);
      }
      if (report.noTrace.before !== null && report.noTrace.after !== null) {
        lines.push('  before:');
        for (const l of report.noTrace.before.split('\n').filter(Boolean)) lines.push(`    ${l}`);
        lines.push('  after:');
        for (const l of report.noTrace.after.split('\n').filter(Boolean)) lines.push(`    ${l}`);
      }
    }
  }

  lines.push('');
  const code = exitCodeFor(report);
  lines.push(`exit ${code}: ${EXIT_CODE_MEANINGS.find(([c]) => c === code)?.[1]}`);
  return lines.join('\n');
}

export function toJson(report) {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...report,
    summary: (() => {
      const { open, waived, survivors, waivedSurvivors, noVerdict } = partition(report.results ?? []);
      return {
        total: (report.results ?? []).length,
        open: open.length,
        waived: waived.length,
        survivors: survivors.length,
        waivedSurvivors: waivedSurvivors.length,
        noVerdict: noVerdict.length,
        // The two halves of `noVerdict`, counted separately. Collapsed into one
        // number they are indistinguishable, and a consumer that has to tell "the
        // catalog is stale" from "the suite hangs" was reading prose to do it.
        // `errored + timedOut === noVerdict` by construction.
        errored: noVerdict.filter((r) => r.verdict === Verdict.ERROR).length,
        timedOut: noVerdict.filter((r) => r.verdict === Verdict.TIMEOUT).length,
        killed: open.filter((r) => r.verdict === Verdict.KILLED).length,
        imprecise: open.filter((r) => r.verdict === Verdict.IMPRECISE).length,
        learned: open.filter((r) => r.verdict === Verdict.LEARNED).length,
      };
    })(),
    // DERIVED, in one place, from the verdict alone -- so `graded` can never
    // contradict the verdict beside it. A consumer that reads this field never has
    // to know which reasons mean "no verdict was possible".
    results: (report.results ?? []).map((r) => ({ ...r, graded: isGraded(r.verdict) })),
    pathSetMismatches: collectPathSetMismatches(report.results),
    exitCode: exitCodeFor(report),
  };
}
