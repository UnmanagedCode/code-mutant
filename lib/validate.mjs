// `validate`: resolve every catalog site against the working tree, run NOTHING.
//
// WHY IT EXISTS: the runner orders baseline -> resolveSites -> canary, so a stale
// anchor -- the normal failure once the implementer edits the code under review --
// costs a whole baseline to discover, once per stale anchor per iteration. This
// answers "does the catalog still resolve?" in about a second.
//
// WHAT IT IS NOT: a gate. It executes no command, so it establishes neither
// baseline nor canary nor clean-tree, and it never emits a verdict. Its output is
// rendered here rather than through report.mjs precisely so the verdict vocabulary
// (KILLED/SURVIVED/PASSED, gate outcomes) cannot leak into a report that measured
// nothing -- the same rule the trust gates already carry, that a check which did
// not run must never read like one that passed.
//
// THE SEVERITY CONTRACT (documented in mutants.schema.md and `--help`, because a
// reviewer will script against it):
//
//   problem  -- `run` could not produce a trustworthy verdict for this mutant.
//               Either the runner's own code refuses it -- and validate reports
//               that by CALLING THAT SAME CODE (resolveSites, planNarrowing,
//               assertMutationDirIgnored), never by re-deciding it -- or the
//               mutant is structurally incapable of reading KILLED.
//   warning  -- validate's own advice. `run` proceeds; something is degraded.
//               A warning NEVER affects the exit code.
//
// A false problem is worse than a missing check: it exits non-zero and blocks a
// review over a catalog that would have run fine. So nothing lands in the problem
// tier on the strength of a source-reading -- only what the runner itself refuses,
// plus `no-expect-fail`, which was justified by observation (see its code below).

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describeGrade, missingCanaryExports } from './adapters/index.mjs';
import { assertMutationDirIgnored } from './catalog.mjs';
import { discoverCanaryTargets, trackedFiles } from './gates.mjs';
import { globToRegExp } from './glob.mjs';
import { planNarrowing } from './narrow.mjs';
import { REPORT_DIR_ENV } from './reports.mjs';
import { ExitCode, SCHEMA_VERSION } from './report.mjs';
import { SiteError, describeSites, resolveSites } from './sites.mjs';

export const Severity = { PROBLEM: 'problem', WARNING: 'warning' };

// Codes NOT listed here are SiteErrorCode's own, reported verbatim: validate
// predicts what `run` would decide rather than judging differently.
export const ValidateCode = {
  UNRESOLVED: 'unresolved',
  NO_EXPECT_FAIL: 'no-expect-fail',
  NO_NARROW_SCOPE: 'no-narrow-scope',
  MUTATION_DIR_NOT_IGNORED: 'mutation-dir-not-ignored',
  REF_FILE_MISSING: 'ref-file-missing',
  REF_SHAPE: 'ref-shape',
  REFS_IGNORED: 'refs-ignored',
  NARROW_DOWNGRADED: 'narrow-downgraded',
  ADAPTER_NO_CANARY: 'adapter-no-canary',
  ADAPTER_NO_TEST_PATTERNS: 'adapter-no-test-patterns',
  REPORT_DIR_UNUSED: 'report-dir-unused',
  ROUTE_OVERLAP: 'route-overlap',
};

export const NOTE = 'pre-flight only: no test was run, so no trust gate was established and '
  + 'nothing here is a verdict. "resolves" means the edit can be applied to this tree; it says '
  + 'nothing about whether a test would catch it.';

function problem(code, detail) { return { severity: Severity.PROBLEM, code, detail }; }
function warning(code, detail) { return { severity: Severity.WARNING, code, detail }; }

// The refs a mutant will actually be narrowed and classified against.
function checkRefs(mutant, adapter, repoRoot) {
  const issues = [];
  const expectFail = mutant.expectFail ?? [];
  const refs = [...expectFail, ...(mutant.expectPass ?? [])];

  if (adapter.grade === 'exit-code') {
    // classify() never consults them at this grade -- the verdict IS the exit code.
    if (refs.length) {
      issues.push(warning(
        ValidateCode.REFS_IGNORED,
        `the ${adapter.name} adapter is exit-code grade, so expectFail/expectPass are not used: `
        + 'the verdict is the gate command\'s exit status. Scope this mutant with "narrowCommand".',
      ));
    }
    return { issues, refs };
  }

  // Counted grade. OBSERVED, not reasoned: a mutant with no expectFail reads
  // IMPRECISE when something catches the mutation and SURVIVED when nothing does
  // -- never KILLED. That SURVIVED is a blocking finding (exit 1) with no test to
  // point at, which is why this is a problem and why `probe` already refuses the
  // same shape outright in counted mode.
  if (!expectFail.length) {
    issues.push(problem(
      ValidateCode.NO_EXPECT_FAIL,
      'counted grade with no "expectFail": this mutant can never read KILLED. If the mutation '
      + 'survives it reports an un-arbitrable SURVIVED (nothing was claimed to fail); if anything '
      + 'catches it, IMPRECISE. Name the test that should fail -- or run `run --learn` to discover it.',
    ));
  }

  for (const ref of refs) {
    if (adapter.refsNameFiles) {
      // adapter.scopeOf is the exact string narrowing will substitute, so this
      // checks the scope that will really run rather than a guess at the format.
      const scope = adapter.scopeOf(ref);
      if (scope && !existsSync(path.resolve(repoRoot, scope))) {
        issues.push(warning(
          ValidateCode.REF_FILE_MISSING,
          `${JSON.stringify(ref)} narrows to ${JSON.stringify(scope)}, which does not exist in this `
          + 'tree -- the scope would run nothing, or fail to load',
        ));
      }
    } else if (String(ref).includes('::')) {
      issues.push(warning(
        ValidateCode.REF_SHAPE,
        `${JSON.stringify(ref)} looks like a "file::name" reference, but ${adapter.name} references `
        + 'do not name files (see the test-reference table in mutants.schema.md)',
      ));
    }
  }

  return { issues, refs };
}

function checkMutant(mutant, { repoRoot, config, adapter }) {
  const issues = [];
  let sites = null;

  try {
    sites = describeSites(resolveSites(repoRoot, mutant.sites).resolved);
  } catch (err) {
    issues.push(problem(err instanceof SiteError ? err.code : ValidateCode.UNRESOLVED, err.message));
  }

  const { issues: refIssues, refs } = checkRefs(mutant, adapter, repoRoot);
  issues.push(...refIssues);

  // Only planned when there is something to plan from: with no refs at all,
  // planNarrowing's throw and no-expect-fail are the same fact, and reporting one
  // cause as two problems is noise.
  if (refs.length) {
    try {
      const narrowing = planNarrowing({ mutant, adapter, testCommand: config.testCommand });
      if (narrowing.requestedNames && narrowing.mode !== 'names') {
        issues.push(warning(
          ValidateCode.NARROW_DOWNGRADED,
          `narrowTo:"names" will not take effect (running at ${narrowing.mode} granularity) -- `
          + `${narrowing.downgradeReason}`,
        ));
      }
    } catch (err) {
      issues.push(problem(ValidateCode.NO_NARROW_SCOPE, err.message));
    }
  }

  return {
    id: mutant.id,
    invariant: mutant.invariant,
    sites,
    issues,
    resolves: !issues.some((i) => i.severity === Severity.PROBLEM),
  };
}

export function validateCatalog({ repoRoot, config, adapter, catalog }) {
  const issues = [];
  // `run` hard-stops on this before it measures anything; catching it here is the
  // same second saved as catching a stale anchor.
  try {
    assertMutationDirIgnored(repoRoot);
  } catch (err) {
    issues.push(problem(ValidateCode.MUTATION_DIR_NOT_IGNORED, err.message));
  }

  // Adapter-level, not per-mutant: every command refuses the whole invocation on
  // it -- `baseline`, `run` and `probe` all go through execute() -- before
  // measuring anything. Reported by CALLING the runner's own predicate
  // rather than re-deciding, which is what keeps it out of the false-problem tier.
  const missingCanary = missingCanaryExports(adapter);
  if (missingCanary.length) {
    issues.push(problem(
      ValidateCode.ADAPTER_NO_CANARY,
      `the ${adapter.name} adapter runs at ${describeGrade(adapter)} but ${adapter.modulePath ?? 'it'} `
      + `does not export ${missingCanary.join(', ')}: every command -- \`baseline\`, \`run\`, \`probe\` -- refuses this `
      + 'harness before it measures anything, because no canary can be synthesised for any target file '
      + 'and every mutant would read SURVIVED unchecked. Export canary(source, { file }) '
      + '(mutants.schema.md Appendix B), or declare `export const grade = "exit-code"`, which needs '
      + 'neither export.',
    ));
  }
  // Independent of the canary check, not an `else`: an adapter missing both
  // learns both facts from one pass rather than one per fix.
  //
  // Keyed on DISCOVERY, not on the patterns being empty: patterns matching no
  // tracked file leave `baseline` in the identical state, and the run-side test
  // for that shape is test/gates.test.mjs's 'cannot find a target file' case.
  // This is the same call the gate makes, with the same no-preferred-files
  // starting point a bare `baseline` has -- it runs no command.
  //
  // Except when git could not answer at all: the gate tolerates that (no
  // candidates from patterns), but "your patterns match nothing" would be a
  // specific false claim about the adapter. Only the pattern half needs git, so a
  // declared-nothing adapter is still reported when git is unavailable.
  // Per route when routed: each route's canary is discovered among its own
  // `tests`, so one route matching nothing is that route's gate failing.
  const units = adapter.routes
    ? adapter.routes.map((route) => ({
      adapter: route.adapter,
      patterns: route.tests,
      commands: [['baselineCommand', route.baselineCommand], ['testCommand', route.testCommand]],
      label: `route ${JSON.stringify(route.name)} (${route.adapter.name})`,
      field: '"tests"',
    }))
    : [{
      adapter,
      patterns: adapter.testFilePatterns ?? [],
      commands: [['baselineCommand', config.baselineCommand], ['testCommand', config.testCommand]],
      label: `the ${adapter.name} adapter`,
      field: '"testFilePatterns"',
    }];
  const tracked = trackedFiles(repoRoot);
  for (const unit of units) {
    const declared = unit.patterns;
    const patternsUncheckable = declared.length > 0 && tracked === null;
    if (unit.adapter.grade === 'counted' && !patternsUncheckable
      && !discoverCanaryTargets({ workspaceRoot: repoRoot, repoRoot, adapter, patterns: declared }).length) {
      issues.push(warning(
        ValidateCode.ADAPTER_NO_TEST_PATTERNS,
        `${unit.label} ${declared.length
          ? `declares ${unit.field} (${declared.join(', ')}) that match no tracked file`
          : `declares no ${unit.field}`}, so \`mutate.mjs baseline\` on its own `
        + 'cannot find a target file and the canary gate fails; `run` works when an "expectFail" reference '
        + 'narrows to a real test file -- the canary is established against that mutant\'s own narrowed '
        + 'command, or from its scopes as candidates when the mutant cannot be narrowed -- and a later '
        + '`baseline` works once a run has journalled a canary target, which only a baseline-scope canary '
        + `produces. Declare ${unit.field} that match this repo's test files to make \`baseline\` self-sufficient.`,
      ));
    }

    // A WARNING, not a problem: the command might reach the dir some way a
    // string search cannot see (a wrapper script reading the env). If it does
    // not, the adapter reads zero tests and the baseline gate fails with the
    // exact flags.
    if (unit.adapter.readsReportDir) {
      const blind = unit.commands.filter(([, command]) => !String(command).includes(REPORT_DIR_ENV));
      if (blind.length) {
        issues.push(warning(
          ValidateCode.REPORT_DIR_UNUSED,
          `${unit.label} reads its results from the report file the command writes into `
          + `$${REPORT_DIR_ENV}, but ${blind.map(([field]) => `"${field}"`).join(' and ')} never mention`
          + `${blind.length === 1 ? 's' : ''} it, so the adapter would see zero tests and the baseline gate would `
          + `fail${unit.adapter.requiredFlags ? `. Pass ${unit.adapter.requiredFlags}` : ''}.`,
        ));
      }
    }
  }

  // First match wins, so an overlap is legal -- but a file the reader expects
  // one runner to judge being judged by another is worth saying out loud.
  if (adapter.routes && tracked) {
    const compiled = adapter.routes.map((route) => ({ name: route.name, regexes: route.tests.map(globToRegExp) }));
    for (const file of tracked) {
      const owners = compiled.filter((route) => route.regexes.some((re) => re.test(file))).map((route) => route.name);
      if (owners.length > 1) {
        issues.push(warning(
          ValidateCode.ROUTE_OVERLAP,
          `${file} matches the "tests" of routes ${owners.map((n) => JSON.stringify(n)).join(', ')}; the first, `
          + `${JSON.stringify(owners[0])}, runs it and the others never do`,
        ));
      }
    }
  }

  const mutants = catalog.mutants.map((mutant) => checkMutant(mutant, { repoRoot, config, adapter }));
  const count = (severity) => issues.filter((i) => i.severity === severity).length
    + mutants.reduce((sum, m) => sum + m.issues.filter((i) => i.severity === severity).length, 0);

  return {
    command: 'validate',
    ranTests: false,
    gatesEstablished: false,
    note: NOTE,
    catalog: catalog.path,
    adapter: { name: adapter.name, grade: adapter.grade, modulePath: adapter.modulePath ?? null },
    issues,
    mutants,
    summary: {
      total: mutants.length,
      resolves: mutants.filter((m) => m.resolves).length,
      withProblems: mutants.filter((m) => !m.resolves).length,
      problems: count(Severity.PROBLEM),
      warnings: count(Severity.WARNING),
    },
  };
}

// A stale anchor IS a catalog error, so this reuses code 4 rather than growing the
// published exit-code contract. Warnings never reach it.
export function validateExitCode(report) {
  return report.summary.problems ? ExitCode.USAGE : ExitCode.CLEAN;
}

// Deliberately carries no `results`, `gates`, `verdict` or `survivors` key: a
// consumer keyed to the run report's shape must not be able to read this as one.
export function toValidateJson(report) {
  return { schemaVersion: SCHEMA_VERSION, ...report, exitCode: validateExitCode(report) };
}

function describeSite(site) {
  if (site.kind === 'patch') return `patch touching ${site.paths.join(', ')}`;
  return site.edits
    .map((edit) => `${site.file}:${edit.line}  ${JSON.stringify(edit.anchor)} -> ${JSON.stringify(edit.replacement)}`)
    .join('\n             ');
}

export function formatValidation(report) {
  const { summary } = report;
  const lines = [
    `code-mutant  validate  [catalog: ${report.catalog}, adapter: ${report.adapter.name} (${report.adapter.grade} grade)]`,
    '',
    '  NO TESTS WERE RUN (ranTests: false). This is a pre-flight resolution check of the',
    '  catalog against the current working tree. It establishes NO trust gate -- not',
    '  clean-tree, not baseline, not canary -- and it is not a verdict. "resolves" means',
    '  the edit can be applied; it says nothing about whether a test would catch it.',
    '',
  ];

  for (const issue of report.issues) {
    lines.push(`  ${issue.severity === Severity.PROBLEM ? 'PROBLEM' : 'warning'}  ${issue.code}  ${issue.detail}`);
  }
  if (report.issues.length) lines.push('');

  lines.push('Mutants');
  if (!report.mutants.length) {
    lines.push('  (the catalog is empty)');
  }
  const idWidth = Math.max(0, ...report.mutants.map((m) => m.id.length));
  for (const mutant of report.mutants) {
    lines.push(`  ${mutant.id.padEnd(idWidth)}  ${mutant.resolves ? 'resolves' : 'PROBLEM '}  ${mutant.invariant}`);
    for (const site of mutant.sites ?? []) lines.push(`             ${describeSite(site)}`);
    for (const issue of mutant.issues) {
      lines.push(`      ${issue.severity === Severity.PROBLEM ? 'PROBLEM' : 'warning'}  ${issue.code}  ${issue.detail}`);
    }
  }

  // Run-level problems (the adapter, the mutation dir) are counted in
  // summary.problems but belong to no mutant, so the per-mutant tally alone reads
  // "0 with a problem" beside exit 4 and points the reader at the wrong file.
  const runLevelProblems = report.issues.filter((i) => i.severity === Severity.PROBLEM).length;
  lines.push('');
  lines.push(
    `${summary.total} mutant(s): ${summary.resolves} resolve, ${summary.withProblems} with a problem. `
    + (runLevelProblems ? `${runLevelProblems} run-level problem(s) above, outside the catalog. ` : '')
    + `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'} (warnings never affect the exit code).`,
  );
  lines.push('');
  let why;
  if (!summary.problems) {
    why = `exit ${ExitCode.CLEAN}: every catalog mutant resolves against this tree. No test was run and no trust gate was established.`;
  } else if (!summary.withProblems) {
    why = `exit ${ExitCode.USAGE}: usage, config, or catalog error -- the run-level problem(s) above; `
      + 'every catalog mutant resolves against this tree.';
  } else {
    why = `exit ${ExitCode.USAGE}: usage, config, or catalog error -- the catalog does not resolve against this tree`
      + `${runLevelProblems ? ', and the run-level problem(s) above' : ''}.`;
  }
  lines.push(why);
  return lines.join('\n');
}
