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

import { Verdict } from './classify.mjs';
import { GateOutcome, collectPathSetMismatches } from './runner.mjs';

export const SCHEMA_VERSION = 1;

export const ExitCode = {
  CLEAN: 0,
  SURVIVORS: 1,
  GATE_FAILED: 2,
  RESTORE_FAILED: 3,
  USAGE: 4,
  NO_VERDICT: 5,
};

export const EXIT_CODE_MEANINGS = [
  [ExitCode.CLEAN, 'no un-waived survivors, every mutant produced a verdict, gates passed'],
  [ExitCode.SURVIVORS, 'at least one UN-WAIVED survivor -- a coverage claim is false'],
  [ExitCode.GATE_FAILED, 'baseline or canary gate failed; no verdict is interpretable'],
  [ExitCode.RESTORE_FAILED, 'restore or the clean-tree assertion failed -- inspect the tree by hand'],
  [ExitCode.USAGE, 'usage, config, or catalog error'],
  [ExitCode.NO_VERDICT, 'no survivors, but some mutant produced no verdict (ERROR/TIMEOUT) -- not a clean proof'],
];

const VERDICT_ORDER = [
  Verdict.SURVIVED, Verdict.IMPRECISE, Verdict.ERROR, Verdict.TIMEOUT, Verdict.KILLED,
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

function matrixRows(results) {
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
      truncate((r.expectFail ?? []).join(', ') || '-', 30),
      truncate((r.failedTests ?? []).join(', ') || '(none)', 30),
      counts(r.narrowBaseline?.counts),
      counts(r.mutantCounts),
      deltaText(r.delta),
    ]);
}

const MATRIX_HEADERS = [
  'id', 'invariant', 'verdict', 'grade', 'repro', 'expected', 'actual', 'base p/f/s', 'mutant p/f/s', 'Δ',
];

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
  if (baseline) {
    lines.push(`  baseline  ${baseline.outcome.toUpperCase()}  ${counts(baseline.counts)} (p/f/s)  ${baseline.detail}`);
  }
  if (canary) {
    lines.push(`  canary    ${canary.status}  [${canary.grade} grade]${canary.target ? `  via ${canary.target}` : ''}`);
    lines.push(`            ${canary.detail}`);
  }
  return lines;
}

function survivorBlock(result, index) {
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
    `     claim:        ${(result.expectFail ?? []).join(', ') || '(no expectFail listed)'} should have failed`,
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
    lines.push(renderTable(MATRIX_HEADERS, matrixRows(open)));
  }

  if (waived.length) {
    lines.push('');
    lines.push('Waived (a recorded conductor decision; still run, reported separately)');
    lines.push(renderTable([...MATRIX_HEADERS, 'reason'], matrixRows(waived).map((row, i) => [
      ...row, truncate(waived[i].waived?.reason, 40),
    ])));
  }

  if (survivors.length) {
    lines.push('');
    lines.push(`Survivors -- ${survivors.length} blocking finding(s), arbitrable without reading project code`);
    lines.push(survivors.map(survivorBlock).join('\n\n'));
  }

  if (waivedSurvivors.length) {
    lines.push('');
    lines.push(`Waived survivors -- ${waivedSurvivors.length} (not counted as open findings)`);
    lines.push(waivedSurvivors.map(survivorBlock).join('\n\n'));
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
        killed: open.filter((r) => r.verdict === Verdict.KILLED).length,
        imprecise: open.filter((r) => r.verdict === Verdict.IMPRECISE).length,
      };
    })(),
    pathSetMismatches: collectPathSetMismatches(report.results),
    exitCode: exitCodeFor(report),
  };
}
