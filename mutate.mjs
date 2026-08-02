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

import { AdapterError, loadAdapter } from './lib/adapters/index.mjs';
import { listCandidates } from './lib/candidates.mjs';
import { CatalogError, assertMutationDirIgnored, loadCatalog, writeResults } from './lib/catalog.mjs';
import { ConfigError, loadConfig } from './lib/config.mjs';
import { checkCleanTree } from './lib/gates.mjs';
import { installGuard } from './lib/guard.mjs';
import { EXIT_CODE_MEANINGS, ExitCode, exitCodeFor, formatReport, toJson } from './lib/report.mjs';
import { execute } from './lib/runner.mjs';
import { SnapshotError } from './lib/snapshot.mjs';
import { SiteError } from './lib/sites.mjs';
import { WorkspaceError, findRepoRoot } from './lib/workspace.mjs';

const HELP = `code-mutant -- mutation-verified coverage proving

USAGE
  node mutate.mjs baseline                    [--copy|--in-place] [--allow-dirty] [--json]
  node mutate.mjs run [--id <id> ...] [--all] [--copy|--in-place] [--jobs N]
                      [--base <branch>] [--allow-dirty] [--json]
  node mutate.mjs probe --file <path> --anchor <text> --replace <text>
                        --expect-fail <test> [...] [--expect-pass <test> ...]
                        [--copy|--in-place] [--json]
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
  probe        One ad-hoc mutation, no catalog entry written. For exploring a
               mutation before adding it to the catalog. The clean-tree gate is
               a warning here, not a refusal -- probe is the escape hatch.
  candidates   List diff hunks (merge-base..working tree) that no catalog mutant
               covers. ADVISORY: it lists, you target. Do not author one mutant
               per hunk -- that is an exhaustive sweep, not this practice.

FLAGS
  --id <id>          Mutant id to run; repeatable. Either this or --all.
  --all              Run every mutant in the catalog.
  --copy             Force copy isolation for this invocation.
  --in-place         Force in-place isolation for this invocation.
  --jobs N           Concurrent mutants (copy mode only; clamped to 1 in-place).
  --base <branch>    run: overrides config.json's baseBranch for the
                     empty-diff-vs-base gate. candidates: base branch/commit
                     (required there; no config fallback).
  --allow-dirty      baseline/run: proceed despite a dirty worktree instead of
                     refusing. Every verdict from that invocation is labelled
                     non-reproducible, in both the matrix and --json.
  --file <path>      probe: file to mutate.
  --anchor <text>    probe: exact substring to replace; must match exactly once.
  --replace <text>   probe: replacement text; must differ from the anchor.
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
  TIMEOUT    The mutation hung the suite. Flagged, never counted as a kill.
  ERROR      No verdict was possible: an anchor is missing or ambiguous, the
             replacement was a no-op, the narrowed scope was already broken or
             ran zero tests, or the command exited non-zero without naming a
             failing test.

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

config.json (harness/mutation/config.json)
  baselineCommand  Required. The project's real "run everything" command.
  testCommand      Required. Per-mutant command containing a {tests} placeholder.
  runner           Required. node-test | pytest | vitest | dotnet | exit-code |
                   custom. "custom" loads parse.mjs from beside config.json,
                   exporting parse(stdout, stderr, exitCode).
  isolation        "in-place" (default) or "copy".
  preserve         Paths symlinked into a copy instead of duplicated, e.g.
                   ["node_modules"].
  timeoutMs        Per-command wall-clock cap. Default 120000.
  jobs             Copy-mode concurrency. Default 1.
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

const BOOLEAN_FLAGS = new Set(['--all', '--copy', '--in-place', '--json', '--help', '-h', '--allow-dirty']);
const REPEATABLE_FLAGS = new Set(['--id', '--expect-fail', '--expect-pass']);
const VALUE_FLAGS = new Set([
  '--jobs', '--base', '--file', '--anchor', '--replace', ...REPEATABLE_FLAGS,
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

async function buildContext(flags, log, { allowBaseOverride = false } = {}) {
  const repoRoot = findRepoRoot(process.cwd());
  const jobsFlag = flags['--jobs'] === undefined ? undefined : Number(flags['--jobs']);
  if (jobsFlag !== undefined && (!Number.isInteger(jobsFlag) || jobsFlag < 1)) {
    throw new Error('--jobs needs a positive integer');
  }
  if (!allowBaseOverride && flags['--base'] !== undefined) {
    throw new Error('--base only applies to `run` (the empty-diff-vs-base gate) and `candidates` (try --help)');
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
  const { config, adapter, repoRoot } = await buildContext(flags, log, { allowBaseOverride: true });
  const ids = lists['--id'] ?? [];
  if (!ids.length && !flags['--all']) {
    throw new Error('run needs either --all or at least one --id (refusing to guess which mutants you meant)');
  }

  const catalog = loadCatalog(repoRoot);
  if (!catalog.exists) {
    throw new CatalogError(
      `no catalog at ${catalog.path}. The catalog is per-review and authored by the reviewer; `
      + 'see mutants.schema.md for the format.',
    );
  }

  let mutants = catalog.mutants;
  if (ids.length) {
    const byId = new Map(mutants.map((m) => [m.id, m]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new CatalogError(`no mutant with id ${missing.join(', ')} in ${catalog.path}`);
    mutants = ids.map((id) => byId.get(id));
  }

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
  });
  report.command = 'run';
  report.catalog = catalog.path;
  report.resultsFile = writeResults(repoRoot, runId(), toJson(report));
  const code = emit(report, flags);
  if (!flags['--json']) log(`results: ${report.resultsFile}`);
  return code;
}

async function commandProbe(flags, lists, log) {
  const { config, adapter, repoRoot } = await buildContext(flags, log);
  for (const required of ['--file', '--anchor', '--replace']) {
    if (flags[required] === undefined) throw new Error(`probe needs ${required}`);
  }
  const expectFail = lists['--expect-fail'] ?? [];
  const expectPass = lists['--expect-pass'] ?? [];
  if (!expectFail.length && adapter.grade === 'counted') {
    throw new Error('probe needs at least one --expect-fail in counted mode (it is what KILLED is measured against)');
  }

  const mutant = {
    id: 'probe',
    invariant: `ad-hoc probe: ${flags['--anchor']} -> ${flags['--replace']}`,
    whyNotEquivalent: '(probe: not recorded in the catalog)',
    sites: [{ file: flags['--file'], anchor: flags['--anchor'], replacement: flags['--replace'] }],
    expectFail,
    expectPass,
    narrowTo: 'file',
  };

  assertMutationDirIgnored(repoRoot);

  // probe is the ad-hoc escape hatch for exploring a mutation before it goes in
  // the catalog, so a dirty tree is worth a warning, not a refusal.
  const clean = checkCleanTree(repoRoot);
  if (!clean.clean) {
    log(`warning: worktree has uncommitted or untracked changes -- probe proceeds anyway (it is exploratory, not recorded in the catalog):\n${clean.status}`);
  }

  const report = await execute({
    config, adapter, mutants: [mutant], log, enforceCleanTree: false,
  });
  report.command = 'probe';
  report.resultsFile = writeResults(repoRoot, `probe-${runId()}`, toJson(report));
  const code = emit(report, flags);
  if (!flags['--json']) log(`results: ${report.resultsFile}`);
  return code;
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
      case 'probe': return await commandProbe(flags, lists, log);
      case 'candidates': return await commandCandidates(flags, log);
      default:
        process.stderr.write(`code-mutant: unknown command ${JSON.stringify(command)} (try --help)\n`);
        return ExitCode.USAGE;
    }
  } catch (err) {
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
