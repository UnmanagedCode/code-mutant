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
import { CANARY_NOT_ESTABLISHED } from './canary-gate.mjs';
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
  [ExitCode.GATE_FAILED, 'baseline or canary gate failed; no verdict is interpretable'],
  [ExitCode.RESTORE_FAILED, 'restore or the clean-tree assertion failed -- inspect the tree by hand'],
  [ExitCode.USAGE, 'usage, config, or catalog error'],
  [ExitCode.NO_VERDICT, 'no survivors, but some mutant produced no verdict (ERROR/TIMEOUT) -- not a clean proof'],
  [ExitCode.NO_HARNESS, 'this project is not configured for mutation testing -- nothing ran, nothing is claimed; NOT an error'],
];

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

function gateLines(report) {
  const lines = ['Trust gates'];
  const cleanTree = report.gates?.cleanTree;
  const baseDiff = report.gates?.baseDiff;
  const baseline = report.gates?.baseline;
  const canary = report.gates?.canary;
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
    // One line per judging command, so "which scope is untrustworthy" is legible
    // without opening --json -- and so a PARTIAL can never look like a pass.
    for (const one of scopes) {
      const state = one.skipped ? 'NOT ATTEMPTED' : (scopeFired(one) ? 'KILLED' : 'NOT FIRED');
      const why = scopeFired(one) ? `via ${one.target}` : one.detail;
      lines.push(`            - ${one.command}   ${state}  ${why}`);
      if (!one.skipped && !scopeFired(one) && one.mutants?.length) {
        lines.push(`              mutants refused: ${one.mutants.join(', ')}`);
      }
    }
  }
  return lines;
}

function survivorBlock(result, index, learn = false) {
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
  if (gatesServed) {
    lines.push(`  GATES FROM CACHE -- baseline and canary were measured ${report.gateCache.measuredAt} against `
      + `a byte-identical tree (key ${report.gateCache.key}, sha ${report.gateCache.measuredSha ?? '(unknown)'}). `
      + 'This invocation measured neither. --remeasure-gates forces a fresh measurement.');
  } else if (baselineOnlyServed) {
    lines.push(`  BASELINE FROM CACHE -- the baseline was measured ${report.gateCache.measuredAt} against a `
      + `byte-identical tree (key ${report.gateCache.key}, sha ${report.gateCache.measuredSha ?? '(unknown)'}). `
      + 'The canary was measured HERE: a narrow-scope canary attests about commands derived from the '
      + 'mutant catalog, which the cache key deliberately does not cover, so it is never cached. '
      + '--remeasure-gates forces a fresh baseline measurement too.');
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

  if (report.gates?.cleanTree?.outcome === GateOutcome.FAILED
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
    lines.push(survivors.map((r, i) => survivorBlock(r, i, report.learn)).join('\n\n'));
  }

  if (waivedSurvivors.length) {
    lines.push('');
    lines.push(`Waived survivors -- ${waivedSurvivors.length} (not counted as open findings)`);
    lines.push(waivedSurvivors.map((r, i) => survivorBlock(r, i, report.learn)).join('\n\n'));
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
