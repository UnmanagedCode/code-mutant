#!/usr/bin/env node
// code-mutant's shared runner: the sole entry point and command surface.
//
// Stack-agnostic, because the test command is just a shell string. Everything
// project-specific is data in `harness/mutation/config.json`, so a read-only
// reviewer can audit the harness before believing its verdicts.
//
// This file is wiring only: parse argv, build state, dispatch. The behaviour lives
// in lib/, with the safety-critical seams (snapshot/restore, anchor resolution,
// isolation) in their own modules so the restore contract can be read without
// reading the reporter.
//
// `mutate.mjs --help` is the authoritative command reference -- scaffold/harness.md
// and skills/prove/SKILL.md both delegate to it rather than duplicating it.

import process from 'node:process';

import { readFileSync } from 'node:fs';

import { AdapterError, loadAdapter } from './lib/adapters/index.mjs';
import { listCandidates } from './lib/candidates.mjs';
import {
  CatalogError, assertMutationDirIgnored, loadCatalog, requireCatalog, selectById, writeResults,
} from './lib/catalog.mjs';
import { ConfigError, NoHarnessError, loadConfig } from './lib/config.mjs';
import { checkCleanTree } from './lib/gates.mjs';
import { installGuard } from './lib/guard.mjs';
import { EXIT_CODE_MEANINGS, ExitCode, exitCodeFor, formatReport, toJson } from './lib/report.mjs';
import { execute } from './lib/runner.mjs';
import { SnapshotError } from './lib/snapshot.mjs';
import { SiteError } from './lib/sites.mjs';
import { formatValidation, toValidateJson, validateCatalog, validateExitCode } from './lib/validate.mjs';
import { WorkspaceError, findRepoRoot } from './lib/workspace.mjs';

const HELP = `code-mutant -- mutation-verified coverage proving

USAGE
  node mutate.mjs baseline                    [--copy|--in-place] [--allow-dirty] [--json]
  node mutate.mjs run [--id <id> ...] [--all] [--learn] [--copy|--in-place] [--jobs N]
                      [--base <branch>] [--allow-dirty] [--resume] [--json]
  node mutate.mjs validate                    [--json]
  node mutate.mjs probe --file <path> --anchor <text> --replace <text>
                        [--learn] [--expect-fail <test> ...] [--expect-pass <test> ...]
                        [--copy|--in-place] [--json]
  node mutate.mjs probe --patch-file <path>   [--learn] [--expect-fail <test> ...]
                        [--expect-pass <test> ...] [--copy|--in-place] [--json]
  node mutate.mjs probe --id <id>             [--copy|--in-place] [--json]
  node mutate.mjs candidates --base <branch>  [--json]

COMMANDS
  baseline     Run the trust gates and stop: clean-tree, baseline, canary.
               Measures the unmutated baselineCommand in the configured
               isolation mode (pass/fail/skip counts) and synthesises a canary.
               Nothing else is trustworthy until this is green and the canary
               comes back KILLED.
  run          Run catalog mutants from .mutation/mutants.json. Per mutant:
               resolve site(s) -> refuse an ambiguous or no-op edit -> measure the
               narrow scope unmutated -> apply -> run -> classify -> restore.
               All three gates run first; there is deliberately no way to skip
               them short of --allow-dirty.
  validate     Resolve every catalog site against the working tree and report
               what would refuse -- RUNNING NO TESTS, so it returns in about a
               second. A pre-flight, NOT a gate: it establishes nothing and
               emits no verdict. See VALIDATE below.
  probe        One ad-hoc mutation, no catalog entry written. For exploring a
               mutation before adding it to the catalog. The clean-tree gate is
               a warning here, not a refusal -- probe is the escape hatch.
               Three mutually exclusive forms: an inline anchor swap
               (--file/--anchor/--replace), a unified diff read from a file
               (--patch-file, the probe form of the catalog's "patch" site), or
               one existing catalog entry re-run as authored (--id).
  candidates   List diff hunks (merge-base..working tree) that no catalog mutant
               covers. ADVISORY: it lists, you target. Do not author one mutant
               per hunk -- that is an exhaustive sweep, not this practice.

FLAGS
  --id <id>          run: mutant id to run; repeatable, either this or --all.
                     probe: the single catalog entry to run (exactly one).
  --all              Run every mutant in the catalog.
  --learn            run/probe only. Suppresses grading: expectFail/expectPass are
                     read only to pick the narrow scope, and the verdict becomes
                     LEARNED (or SURVIVED for an empty set) instead of KILLED/
                     IMPRECISE. Reports the observed failing set to fill
                     expectFail from, instead of guessing it. run --all --learn
                     batches this over the whole catalog in one invocation.
  --copy             Force copy isolation for this invocation.
  --in-place         Force in-place isolation for this invocation.
  --jobs N           Concurrent mutants (copy mode only; clamped to 1 in-place).
                     Each worker owns one copy exclusively. N > 1 also runs the
                     project's suite N times at once, so keep N=1 for a suite
                     with a fixed port, a fixed temp/data dir, a shared DB or
                     in-place fixture, a shared write cache, or absolute-path
                     dependence. "preserve" paths are symlinked, so shared.
  --base <branch>    run: overrides config.json's baseBranch for the
                     empty-diff-vs-base gate. candidates: base branch/commit
                     (required there; no config fallback).
  --allow-dirty      baseline/run: proceed despite a dirty worktree instead of
                     refusing. Every verdict from that invocation is labelled
                     non-reproducible, in both the matrix and --json.
  --resume           run: reuse per-mutant verdicts already journalled for this
                     exact sha, config, adapter, isolation and jobs, instead of
                     re-measuring them. Every gate still runs in full, so a
                     resumed run still pays the baseline and canary. Opt-in:
                     a reused verdict is one an unwatched process produced, and
                     it is labelled fromJournal so it never reads as one this
                     run made. Incompatible with --allow-dirty.
  --file <path>      probe: file to mutate.
  --anchor <text>    probe: exact substring to replace; must match exactly once.
  --replace <text>   probe: replacement text; must differ from the anchor.
  --patch-file <p>   probe: path to a file holding a unified diff to apply as the
                     mutation. A PATH, not the diff text -- the catalog's "patch"
                     field takes the text; this takes the file holding it.
  --expect-fail <t>  probe: test that should fail; repeatable.
  --expect-pass <t>  probe: test that must keep passing; repeatable.
  --json             Emit the machine report on stdout instead of the matrix.
  -h, --help         This text.

VERDICTS
  KILLED     Exactly the expectFail tests failed, and every expectPass test
             still passed.
  SURVIVED   The suite stayed green and the command exited 0 -- THE FINDING: the
             coverage claim is false.
  IMPRECISE  A compile/build break, or failures outside expectFail. The mutant
             itself is invalid (often an equivalent mutant); rewrite it smaller
             rather than reporting it.
  TIMEOUT    The MUTANT RUN was killed at its deadline. Flagged, never counted
             as a kill. The same scope completed unmutated moments earlier, so
             the mutation hung it -- rewrite it smaller. (hang.blame is always
             "mutation" here.) A hung UNMUTATED scope is an ERROR, not this.
  ERROR      No verdict was possible: an anchor is missing or ambiguous, the
             replacement was a no-op, the narrowed scope was already broken or
             ran zero tests, the narrowed scope was killed at its deadline
             before any mutation was applied (scope-timed-out, hang.blame
             "suite" -- report that project defect upward; rewriting or
             dropping the mutant cannot fix it), or the command exited non-zero
             without naming a failing test.
  LEARNED    --learn only: the observed failing set, reported without grading.
             Never produced by a graded run.

VALIDATE
  Runs no test, so it establishes no trust gate and produces no verdict. Exit 0
  means "every catalog mutant resolves against this tree" -- never "the gates
  passed". Two severities, and the split is a contract you may script against:
    problem  run could not produce a trustworthy verdict -- for this mutant, or
             for the whole invocation. Either the runner's own code refuses it
             -- validate reports that by calling that same code, not by
             re-deciding it -- or the mutant is structurally incapable of
             reading KILLED (counted grade with no expectFail). Any problem
             exits 4, the usual catalog-error code.
    warning  validate's own advice; run proceeds, something is degraded.
             NEVER affects the exit code.
  Per-code table: mutants.schema.md, "Pre-flight validation".

SIGNAL GRADES
  counted    The adapter parses pass/fail/skip counts and failed test names, so
             IMPRECISE is detectable and KILLED means precision was established.
  exit-code  0/non-zero only (a gate like 'npx tsc --noEmit' or 'npm run snap').
             KILLED vs SURVIVED still work; IMPRECISE detection does not. Every
             verdict is labelled with its grade so an exit-code kill is never
             presented as established precision.

NARROWING
  In counted mode, {tests} in testCommand is substituted with the smallest scope
  that BOTH includes every expectFail/expectPass test AND still lets the adapter
  observe failures outside expectFail -- file-path granularity by default (for
  the dotnet adapter, the declaring type, since its output carries no file).
  That second condition is what keeps IMPRECISE detectable: running exactly the
  named tests would make "a failure outside expectFail" unobservable, silently
  gutting the verdict that catches equivalent mutants.
  A mutant may opt into name-level narrowing with "narrowTo": "names"; the report
  then labels it, because its IMPRECISE detection is limited to expectPass.
  In exit-code mode there is no substitution -- the whole gate command runs. A
  per-mutant "narrowCommand" overrides the substituted testCommand entirely.
  --learn with no expectFail/expectPass at all falls back to baselineCommand
  (the whole suite) rather than refusing, since discovery has no scope to narrow.

config.json (harness/mutation/config.json)
  baselineCommand  Required. The project's real "run everything" command.
  testCommand      Required. Per-mutant command containing a {tests} placeholder.
  runner           Required. node-test | pytest | vitest | dotnet | exit-code |
                   custom. "custom" loads parse.mjs from beside config.json,
                   exporting parse(stdout, stderr, exitCode).
  isolation        "in-place" (default) or "copy".
  preserve         Paths symlinked into a copy instead of duplicated, e.g.
                   ["node_modules"].
  timeoutMs        Per-command wall-clock ceiling, and the fallback for any
                   command with no unmutated reference. Default 120000.
  hang             {factor, floorMs} -- the adaptive deadline for a command
                   that HAS a reference (a mutant run, a canary attempt):
                   min(timeoutMs, max(floorMs, factor * referenceMs)), so
                   only ever tighter than timeoutMs. Default
                   {factor: 10, floorMs: 10000}. factor 0 disables it.
  jobs             Copy-mode concurrency. Default 1. See --jobs above for what
                   makes a suite unsafe to run concurrently.
  baseBranch       Optional. run's empty-diff-vs-base gate compares against
                   this branch; --base overrides it per invocation. Unset (or
                   equal to the branch HEAD is on) reports NOT-ESTABLISHED
                   rather than silently not checking.
  setup/teardown   Optional commands run around every measured command.

TRUST GATES
  clean-tree        baseline/run only (probe warns instead). Refuses when the
                     worktree has uncommitted or untracked-and-not-gitignored
                     changes -- mutation must run against committed, re-runnable
                     state. --allow-dirty overrides it (labelled non-reproducible).
  empty-diff-vs-base run only. Refuses when there is no diff between baseBranch
                     and the working tree -- a clean tree identical to its base
                     has nothing committed to mutate, and mutating it would
                     report a false clean sweep. NOT-ESTABLISHED (not a
                     refusal) when no baseBranch is configured, or it names the
                     branch HEAD is already on.
  baseline           See the baseline command above.
  canary             Synthesised per run, never committed; see mutants.schema.md.

RESTORE
  copy      -- restore is discarding the copy, which was taken from the working
               tree so uncommitted changes are included.
  in-place  -- restore is byte-snapshot replay over every path the mutant
               touched (absence included, since a patch can create and delete
               files), then a byte-identity check and a git-status comparison.
  No git operation is ever used to restore: neither 'git checkout --' nor
  'git apply --reverse'. Both silently destroy uncommitted edits to the file
  being mutated, and uncommitted work in a worker's tree is normal.
  Restore is wired to exit/SIGINT/SIGTERM.

EXIT CODES
${EXIT_CODE_MEANINGS.map(([code, meaning]) => `  ${code}  ${meaning}`).join('\n')}

The catalog format is specified in mutants.schema.md, which also documents the
--json report shape and the adapter parse() contract.
`;

const BOOLEAN_FLAGS = new Set([
  '--all', '--copy', '--in-place', '--json', '--help', '-h', '--allow-dirty', '--learn', '--resume',
]);
const REPEATABLE_FLAGS = new Set(['--id', '--expect-fail', '--expect-pass']);
const VALUE_FLAGS = new Set([
  '--jobs', '--base', '--file', '--anchor', '--replace', '--patch-file', ...REPEATABLE_FLAGS,
]);

export function parseArgs(argv) {
  const parsed = { command: null, flags: {}, lists: {} };
  let index = 0;

  if (argv[index] && !argv[index].startsWith('-')) {
    parsed.command = argv[index];
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (BOOLEAN_FLAGS.has(token)) {
      parsed.flags[token] = true;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      index += 1;
      if (REPEATABLE_FLAGS.has(token)) {
        parsed.lists[token] = [...(parsed.lists[token] ?? []), value];
      } else {
        parsed.flags[token] = value;
      }
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(token)} (try --help)`);
  }
  return parsed;
}

function isolationOverride(flags) {
  if (flags['--copy'] && flags['--in-place']) {
    throw new Error('--copy and --in-place are mutually exclusive');
  }
  if (flags['--copy']) return 'copy';
  if (flags['--in-place']) return 'in-place';
  return null;
}

function runId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

async function buildContext(flags, log, { allowBaseOverride = false, allowLearn = false } = {}) {
  const repoRoot = findRepoRoot(process.cwd());
  const jobsFlag = flags['--jobs'] === undefined ? undefined : Number(flags['--jobs']);
  if (jobsFlag !== undefined && (!Number.isInteger(jobsFlag) || jobsFlag < 1)) {
    throw new Error('--jobs needs a positive integer');
  }
  if (!allowBaseOverride && flags['--base'] !== undefined) {
    throw new Error('--base only applies to `run` (the empty-diff-vs-base gate) and `candidates` (try --help)');
  }
  if (!allowLearn && flags['--learn']) {
    throw new Error('--learn only applies to `run` and `probe` (try --help)');
  }
  const config = loadConfig({
    repoRoot,
    overrides: {
      isolation: isolationOverride(flags),
      jobs: jobsFlag,
      baseBranch: allowBaseOverride ? flags['--base'] : undefined,
    },
    warn: (message) => log(`note: ${message}`),
  });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  if (allowLearn && flags['--learn'] && adapter.grade === 'exit-code') {
    throw new Error(
      `--learn needs a counted-grade adapter; the ${adapter.name} adapter is exit-code grade and never `
      + 'names a failing test, so there is nothing to discover',
    );
  }
  return { repoRoot, config, adapter };
}

function emit(report, flags) {
  if (flags['--json']) {
    process.stdout.write(`${JSON.stringify(toJson(report), null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  return exitCodeFor(report);
}

async function commandBaseline(flags, log) {
  const { config, adapter } = await buildContext(flags, log);
  // Both gates and nothing else: `execute` with an empty mutant list runs the
  // baseline measurement and the canary, which is what the reviewer's gate step
  // needs to see in one command. The clean-tree check runs here too (a baseline
  // measured on a dirty tree is exactly how a bogus skip-count discrepancy got
  // into a real review), but not the empty-diff-vs-base check: baseline does not
  // touch catalog entries, so there is nothing "no committed work" would protect.
  const report = await execute({
    config, adapter, mutants: [], log, allowDirty: Boolean(flags['--allow-dirty']),
  });
  report.command = 'baseline';
  return emit(report, flags);
}

async function commandRun(flags, lists, log) {
  const { config, adapter, repoRoot } = await buildContext(flags, log, { allowBaseOverride: true, allowLearn: true });
  const ids = lists['--id'] ?? [];
  if (!ids.length && !flags['--all']) {
    throw new Error('run needs either --all or at least one --id (refusing to guess which mutants you meant)');
  }

  // Refused rather than silently ignoring one of the two: --allow-dirty produces
  // non-reproducible verdicts and nothing journals them, so --resume would have
  // nothing to reuse AND nothing to record. Saying so beats a run that quietly
  // resumes nothing.
  if (flags['--resume'] && flags['--allow-dirty']) {
    throw new Error(
      '--resume and --allow-dirty are incompatible: a --allow-dirty run\'s verdicts are '
      + 'non-reproducible, so they are never journalled and there is nothing to resume from',
    );
  }

  const catalog = requireCatalog(repoRoot);
  const mutants = ids.length ? selectById(catalog, ids) : catalog.mutants;

  // Checked BEFORE the run, not after: the guard is a hard stop, and discovering
  // it only once the suite has been run several times would waste the whole run.
  assertMutationDirIgnored(repoRoot);

  const report = await execute({
    config,
    adapter,
    mutants,
    log,
    allowDirty: Boolean(flags['--allow-dirty']),
    checkBaseDiff: true,
    base: config.baseBranch,
    learn: Boolean(flags['--learn']),
    resume: Boolean(flags['--resume']),
    journalling: true,
  });
  report.command = 'run';
  report.catalog = catalog.path;
  report.resultsFile = writeResults(repoRoot, runId(), toJson(report));
  const code = emit(report, flags);
  // Emitted on stderr regardless of --json, because --json owns stdout and this
  // has to reach a human reading a scrollback as well as a machine reading the
  // `resumable` field. Advisory only: no gate, no effect on `code`.
  if (report.resumable) {
    log(`resumable: ${report.resumable.available} verdict(s) for this exact sha and config are already `
      + `journalled (key ${report.resumable.key}). Re-run with --resume to reuse them instead of `
      + 're-measuring; the gates re-run either way.');
  }
  if (!flags['--json']) log(`results: ${report.resultsFile}`);
  return code;
}

function readPatchFile(patchPath) {
  let text;
  try {
    text = readFileSync(patchPath, 'utf8');
  } catch (err) {
    throw new Error(`--patch-file ${patchPath}: cannot read it (${err.message})`);
  }
  if (!text.trim()) throw new Error(`--patch-file ${patchPath} is empty`);
  return text;
}

const PROBE_ANCHOR_FLAGS = ['--file', '--anchor', '--replace'];

// probe's three mutually exclusive forms. Refusing an ambiguous combination
// rather than picking one: the whole point of probe is a fast, unsurprising
// iteration loop, and silently ignoring half the flags is neither.
function probeForm(flags, ids) {
  const anchor = PROBE_ANCHOR_FLAGS.some((f) => flags[f] !== undefined);
  const patch = flags['--patch-file'] !== undefined;
  const catalog = ids.length > 0;

  const given = [anchor && 'an inline anchor swap (--file/--anchor/--replace)', patch && '--patch-file', catalog && '--id']
    .filter(Boolean);
  if (given.length > 1) {
    throw new Error(`probe takes exactly one mutation form; got ${given.join(' and ')}`);
  }
  if (!given.length) {
    throw new Error(
      'probe needs a mutation: --file/--anchor/--replace for an inline anchor swap, --patch-file '
      + '<path> for a unified diff, or --id <id> for one catalog entry (try --help)',
    );
  }
  if (anchor) {
    for (const required of PROBE_ANCHOR_FLAGS) {
      if (flags[required] === undefined) throw new Error(`probe needs ${required}`);
    }
    return 'anchor';
  }
  return patch ? 'patch' : 'catalog';
}

async function commandProbe(flags, lists, log) {
  const { config, adapter, repoRoot } = await buildContext(flags, log, { allowLearn: true });
  const ids = lists['--id'] ?? [];
  const form = probeForm(flags, ids);
  const learn = Boolean(flags['--learn']);

  const expectFail = lists['--expect-fail'] ?? [];
  const expectPass = lists['--expect-pass'] ?? [];

  let mutant;
  if (form === 'catalog') {
    if (ids.length > 1) throw new Error(`probe runs exactly one catalog entry; got --id ${ids.join(' --id ')}`);
    if (expectFail.length || expectPass.length) {
      throw new Error(
        'probe --id runs the catalog entry as authored, so it owns its expectFail/expectPass. '
        + 'Drop --expect-fail/--expect-pass, or edit the entry.',
      );
    }
    // Verbatim, including narrowTo/narrowCommand: "run this entry under probe's
    // gates" means the entry, not a re-derivation of it.
    mutant = selectById(requireCatalog(repoRoot), ids)[0];
  } else {
    if (!expectFail.length && adapter.grade === 'counted' && !learn) {
      throw new Error('probe needs at least one --expect-fail in counted mode (it is what KILLED is measured against)');
    }
    const site = form === 'patch'
      ? { patch: readPatchFile(flags['--patch-file']) }
      : { file: flags['--file'], anchor: flags['--anchor'], replacement: flags['--replace'] };
    mutant = {
      id: 'probe',
      invariant: form === 'patch'
        ? `ad-hoc probe: patch from ${flags['--patch-file']}`
        : `ad-hoc probe: ${flags['--anchor']} -> ${flags['--replace']}`,
      whyNotEquivalent: '(probe: not recorded in the catalog)',
      sites: [site],
      expectFail,
      expectPass,
      narrowTo: 'file',
    };
  }

  assertMutationDirIgnored(repoRoot);

  // probe is the ad-hoc escape hatch for exploring a mutation before it goes in
  // the catalog, so a dirty tree is worth a warning, not a refusal.
  const clean = checkCleanTree(repoRoot);
  if (!clean.clean) {
    log(`warning: worktree has uncommitted or untracked changes -- probe proceeds anyway (it is exploratory, not recorded in the catalog):\n${clean.status}`);
  }

  const report = await execute({
    config, adapter, mutants: [mutant], log, enforceCleanTree: false, learn,
  });
  report.command = 'probe';
  report.resultsFile = writeResults(repoRoot, `probe-${runId()}`, toJson(report));
  const code = emit(report, flags);
  if (!flags['--json']) log(`results: ${report.resultsFile}`);
  return code;
}

async function commandValidate(flags, log) {
  const { config, adapter, repoRoot } = await buildContext(flags, log);
  // No workspace is opened and no gate is run: validate resolves against the
  // working tree exactly as it stands, which is the point -- the anchor that went
  // stale did so against the implementer's current, uncommitted edits.
  const report = validateCatalog({
    repoRoot, config, adapter, catalog: requireCatalog(repoRoot),
  });

  if (flags['--json']) {
    process.stdout.write(`${JSON.stringify(toValidateJson(report), null, 2)}\n`);
  } else {
    process.stdout.write(`${formatValidation(report)}\n`);
  }
  return validateExitCode(report);
}

async function commandCandidates(flags, log) {
  const repoRoot = findRepoRoot(process.cwd());
  const base = flags['--base'];
  if (!base) throw new Error('candidates needs --base <branch>');

  const catalog = loadCatalog(repoRoot);
  const listing = listCandidates({ repoRoot, base, mutants: catalog.mutants });

  if (flags['--json']) {
    process.stdout.write(`${JSON.stringify({ ...listing, catalog: catalog.path, catalogMutants: catalog.mutants.length }, null, 2)}\n`);
    return ExitCode.CLEAN;
  }

  const lines = [
    `candidates vs ${base} (merge-base ${listing.mergeBase.slice(0, 12)}, working tree included)`,
    `${listing.hunkCount} hunk(s): ${listing.covered.length} covered by ${catalog.mutants.length} catalog mutant(s), ${listing.uncovered.length} uncovered`,
    '',
    listing.advisory,
    '',
  ];
  if (listing.uncovered.length) {
    lines.push('Uncovered hunks:');
    for (const hunk of listing.uncovered) {
      lines.push(`  ${hunk.file}:${hunk.start}${hunk.end === hunk.start ? '' : `-${hunk.end}`}  (+${hunk.lines})`);
      for (const preview of hunk.preview) lines.push(`      ${preview}`);
    }
  } else {
    lines.push('Every hunk is covered by an existing catalog mutant.');
  }
  if (listing.covered.length) {
    lines.push('');
    lines.push('Covered hunks:');
    for (const hunk of listing.covered) {
      lines.push(`  ${hunk.file}:${hunk.start}${hunk.end === hunk.start ? '' : `-${hunk.end}`}  <- ${hunk.coveredBy.join(', ')}`);
    }
  }
  if (listing.staleAnchors.length) {
    lines.push('');
    lines.push('Catalog mutants whose sites no longer resolve (they cover nothing):');
    for (const stale of listing.staleAnchors) {
      lines.push(`  ${stale.id}: ${stale.unresolved.map((u) => `${u.file ?? '?'} (${u.error})`).join(', ')}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return ExitCode.CLEAN;
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`code-mutant: ${err.message}\n`);
    return ExitCode.USAGE;
  }

  const { command, flags, lists } = parsed;
  if (flags['--help'] || flags['-h'] || !command) {
    process.stdout.write(HELP);
    return command ? ExitCode.CLEAN : ExitCode.USAGE;
  }

  const log = (message) => process.stderr.write(`code-mutant: ${message}\n`);
  installGuard();

  try {
    switch (command) {
      case 'baseline': return await commandBaseline(flags, log);
      case 'run': return await commandRun(flags, lists, log);
      case 'validate': return await commandValidate(flags, log);
      case 'probe': return await commandProbe(flags, lists, log);
      case 'candidates': return await commandCandidates(flags, log);
      default:
        process.stderr.write(`code-mutant: unknown command ${JSON.stringify(command)} (try --help)\n`);
        return ExitCode.USAGE;
    }
  } catch (err) {
    // Not a failure: a project without a harness is configured for none. stdout,
    // no error prefix, and its own code -- exit 0 would read as a clean sweep.
    if (err instanceof NoHarnessError) {
      process.stdout.write(`${err.message}\n`);
      return ExitCode.NO_HARNESS;
    }
    process.stderr.write(`code-mutant: ${err.message}\n`);
    if (err.stack && process.env.CODE_MUTANT_DEBUG) process.stderr.write(`${err.stack}\n`);
    // A restore or byte-identity failure is its own exit code, because it means
    // the tree may not be as the run found it -- a human has to look.
    if (err instanceof SnapshotError) return ExitCode.RESTORE_FAILED;
    if (err instanceof ConfigError || err instanceof CatalogError || err instanceof WorkspaceError
      || err instanceof AdapterError || err instanceof SiteError) {
      return ExitCode.USAGE;
    }
    return ExitCode.USAGE;
  }
}

const isEntryPoint = process.argv[1]
  && (process.argv[1].endsWith('mutate.mjs') || process.argv[1].endsWith('mutate'));
if (isEntryPoint) {
  process.exitCode = await main(process.argv.slice(2));
}
