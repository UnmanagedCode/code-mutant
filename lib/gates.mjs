// The two trust gates, plus the per-scope narrow baseline.
//
// Without these, the runner's output is worthless in a specific and dangerous
// way: a test command that silently runs zero tests reports every mutant
// SURVIVED (every finding false), and one that always errors reports every mutant
// KILLED (a fake-clean verdict). Both gates are mandatory and neither has a skip
// flag -- a gate with an escape hatch is not a gate.
//
// THE CANARY IS SYNTHESISED PER RUN AND NEVER COMMITTED. A committed canary would
// be an anchor-coupled mutant living in the repo, and it would rot worse than a
// catalog entry does: a stale catalog mutant is ignorable noise, a stale canary is
// a mandatory gate that blocks every review, with no role able to re-seed it (the
// reviewer is read-only, the implementer is barred from mutation artifacts, the
// scaffold fires once). Synthesising it removes the whole failure class.
//
// It is injected into an EXISTING, already-discovered test file rather than
// written as a new file, so it is guaranteed to be inside the command's scope. A
// new file might sit outside the project's test glob and "not fire" for reasons
// having nothing to do with the harness being trustworthy.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describeGrade, missingCanaryExports } from './adapters/index.mjs';
import { CANARY_INVALID_LINE } from './adapters/common.mjs';
import { baseDistance, describeDistance, mergeBase } from './candidates.mjs';
import { gitCapture } from './git.mjs';
import { captureSnapshot, restoreAndVerify, trackSnapshot } from './snapshot.mjs';
import { deadlineFor, describeNotGreen, isGreen, measure } from './measure.mjs';
import { gitStatusPorcelain } from './workspace.mjs';

export const CanaryStatus = {
  KILLED: 'KILLED',
  FAILED: 'FAILED',
  NOT_ESTABLISHED: 'NOT-ESTABLISHED',
};

// Shared by every gate the runner enforces (baseline, canary, and the clean-tree
// precondition below), so a caller can never tell "this gate did not run" apart
// from "this gate passed" -- that ambiguity is exactly what made the exit-code
// baseline canary's NOT-ESTABLISHED status readable as PASSED.
export const GateOutcome = { PASSED: 'passed', FAILED: 'failed', NOT_ESTABLISHED: 'not-established' };

function currentBranchName(repoRoot) {
  try {
    const name = gitCapture(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return name === 'HEAD' ? null : name; // detached HEAD has no branch name
  } catch {
    return null;
  }
}

export function headSha(repoRoot) {
  try {
    return gitCapture(repoRoot, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

// The clean-tree precondition, half one: mutation must run against committed
// state, so a survivor is re-runnable against a sha by anyone. `git status
// --porcelain` already excludes gitignored paths by default, so a gitignored
// `.mutation/` never trips this on its own.
export function checkCleanTree(repoRoot) {
  const status = gitStatusPorcelain(repoRoot);
  return { clean: status.trim() === '', status };
}

// The clean-tree precondition, half two: a tree identical to its own base has
// nothing committed to mutate, and mutating it would report a false clean
// sweep. Only ever a hard refusal when `base` is both configured AND distinct
// from the branch HEAD is on -- otherwise (no base configured, or someone
// working directly on the base branch with everything committed) the check
// cannot mean anything, and NOT-ESTABLISHED says so rather than silently not
// running: a gate that did not run must never read the same as one that did.
export function checkBaseDiffGate(repoRoot, base, { maxBuffer } = {}) {
  const currentBranch = currentBranchName(repoRoot);

  if (!base) {
    return {
      outcome: GateOutcome.NOT_ESTABLISHED,
      code: null,
      base: null,
      currentBranch,
      detail: 'no baseBranch configured (harness/mutation/config.json "baseBranch", or --base) -- the '
        + 'empty-diff-vs-base check did not run',
    };
  }

  if (base === currentBranch) {
    return {
      outcome: GateOutcome.NOT_ESTABLISHED,
      code: null,
      base,
      currentBranch,
      detail: `baseBranch (${base}) is the branch HEAD is already on -- comparing it against itself `
        + 'cannot mean anything, so the empty-diff-vs-base check did not run',
    };
  }

  let mergeBaseSha;
  try {
    mergeBaseSha = mergeBase(repoRoot, base);
  } catch (err) {
    // A typo'd branch name is a gate failure, not a process exit: every other
    // gate produces a structured record, and a --json consumer must be able to
    // read this one the same way rather than getting a bare crash.
    return {
      outcome: GateOutcome.FAILED,
      code: 'base-unresolvable',
      base,
      currentBranch,
      detail: err.message,
    };
  }

  // Emptiness is read from `--shortstat`, whose output does not grow with the
  // distance to the base -- the whole diff would, and asking for megabytes of it
  // to answer one boolean is what made a far-behind base an ENOBUFS crash.
  let empty;
  let distance;
  try {
    ({ empty, distance } = baseDistance(repoRoot, mergeBaseSha, { maxBuffer }));
  } catch (err) {
    // Same discipline as base-unresolvable above, and for the same reason: a
    // throw from here would escape past this record, past the results file, and
    // out as a bare usage exit. This function has no throwing path.
    return {
      outcome: GateOutcome.FAILED,
      code: 'base-diff-unreadable',
      base,
      currentBranch,
      mergeBase: mergeBaseSha,
      distance: null,
      detail: err.message,
    };
  }

  return {
    outcome: empty ? GateOutcome.FAILED : GateOutcome.PASSED,
    code: empty ? 'empty-diff-vs-base' : null,
    base,
    currentBranch,
    mergeBase: mergeBaseSha,
    distance: empty ? null : distance,
    detail: empty
      ? `no diff between ${base} (merge-base ${mergeBaseSha.slice(0, 12)}, ${distance.commitsAhead} commit(s) `
        + 'ahead) and the working tree -- nothing committed to mutate; mutating this tree would report a '
        + 'false clean sweep'
      : `${describeDistance(base, mergeBaseSha, distance)} differs from the working tree -- there is `
        + 'committed work to mutate',
  };
}

// Bounded so a project with hundreds of test files does not turn the gate into a
// full extra suite run per candidate. The budget counts MEASURED COMMANDS, not
// candidates looked at: a candidate the adapter declines runs nothing, so
// charging it to this budget would fail the gate on a harness whose next
// candidate fires -- the same defect as stopping at the first decline, five
// candidates further out.
const MAX_CANARY_ATTEMPTS = 5;

// Declines are not free either -- each is a file read and an adapter call -- and
// a pattern like `**/test/**/*.mjs` can match every helper and fixture in a
// monorepo, so the walk still ends. Well clear of any plausible run of
// consecutive declines ahead of a real test file.
const MAX_CANARY_DECLINES = 50;

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**/').join('\0')
    .split('*').join('[^/]*')
    .split('\0').join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

// NULL when git itself could not answer, as distinct from `[]` for a repo that
// really tracks nothing. The gate treats both as "no candidates from patterns",
// but a caller reasoning about the patterns must not report a git failure as
// "your patterns match nothing" -- see lib/validate.mjs.
export function trackedFiles(repoRoot) {
  try {
    return gitCapture(repoRoot, ['ls-files']).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

// Candidate order matters: a file the run will already exercise is strictly
// better than one merely matching a glob, because it proves the command's real
// scope rather than the adapter's guess at it.
export function discoverCanaryTargets({ workspaceRoot, repoRoot, adapter, preferredFiles = [] }) {
  const candidates = [];
  const seen = new Set();
  const add = (rel) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    if (existsSync(path.resolve(workspaceRoot, rel))) candidates.push(rel);
  };

  for (const file of preferredFiles) add(file);

  const patterns = (adapter.testFilePatterns ?? []).map(globToRegExp);
  if (patterns.length) {
    for (const file of (trackedFiles(repoRoot) ?? []).sort()) {
      if (patterns.some((re) => re.test(file))) add(file);
    }
  }
  return candidates;
}

// The gate record for an adapter that can never establish a canary at all, so
// the prose exists in exactly one place and every caller agrees by construction:
// the gate below, the runner's pre-flight (lib/runner.mjs, which is what spares
// every `execute()` caller the baseline before this is known), and validate.
export function canaryPrerequisiteFailure(adapter) {
  const missing = missingCanaryExports(adapter);
  if (!missing.length) return null;
  return {
    status: CanaryStatus.FAILED,
    // The adapter's own grade, verbatim: a record claiming 'counted' beside a
    // detail naming grade "Counted" would assert two different things about one
    // adapter, and the malformed grade IS the diagnosis.
    grade: adapter.grade ?? null,
    target: null,
    attempts: [],
    detail: `the ${adapter.name} adapter runs at ${describeGrade(adapter)} but ${adapter.modulePath ?? 'it'} `
      + `does not export ${missing.join(', ')}, so no canary can be synthesised for any target file. `
      + 'Only exit-code grade needs neither export (mutants.schema.md Appendix B); at every other grade '
      + 'canary(source, { file }) is required. A command with no named tests should declare '
      + '`export const grade = "exit-code"`.',
  };
}

async function runCanaryOnce({ config, adapter, workspace, command, target, inject, deadlineMs }) {
  const abs = path.resolve(workspace.root, target);
  const source = readFileSync(abs, 'utf8');
  const injected = inject(source, { file: target });
  if (!injected) return null;

  const snapshot = trackSnapshot(captureSnapshot(workspace.root, [target]));
  let outcome;
  try {
    writeFileSync(abs, injected.content);
    outcome = await measure({
      command, config, adapter, workspace, deadlineMs,
    });
  } finally {
    restoreAndVerify(snapshot);
  }
  return { injected, ...outcome };
}

// `scope` is 'baseline' (the full gate command, no mutant in play) or 'mutant'
// (the narrowed command for a specific mutant).
//
// Wrapped for the timing rather than stamped at each of the seven return points:
// the gate's own wall clock is the number that answers "is the canary a second
// whole-suite run?", and every failed attempt inside it is part of that answer.
export async function runCanaryGate(args) {
  const startedAt = process.hrtime.bigint();
  const gate = await canaryGate(args);
  return { ...gate, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
}

async function canaryGate({
  config, adapter, workspace, command, preferredFiles = [], siteFiles = [], scope = 'baseline',
  referenceMs = null,
}) {
  // The canary runs the SAME COMMAND that was just measured unmutated -- the
  // global baseline at baseline scope, the mutant's narrow scope at mutant scope
  // -- so it always has a like-for-like reference. This is the change that caps
  // the gate's worst case at ~5x a derived deadline instead of 5x the ceiling.
  const deadlineMs = deadlineFor(config, referenceMs);
  // --- exit-code grade -----------------------------------------------------
  // No named tests exist to append one to, so the canary breaks a file the gate
  // demonstrably exercises: the mutant's own site file. For a bare `baseline`
  // there is no site file yet, so the gate is reported as not established rather
  // than claimed. Its verdict grade is already degraded and labelled; labelling
  // the canary the same way is the consistent move, and it never passes silently.
  if (adapter.grade === 'exit-code') {
    if (scope !== 'mutant' || !siteFiles.length) {
      return {
        status: CanaryStatus.NOT_ESTABLISHED,
        grade: 'exit-code',
        target: null,
        detail: 'exit-code grade has no named tests to inject a canary into; it is established '
          + 'per-mutant during `run`, against the mutant\'s own site file. Expected at baseline, not a stop condition.',
      };
    }
    const target = siteFiles[0];
    const outcome = await runCanaryOnce({
      config,
      adapter,
      workspace,
      command,
      target,
      deadlineMs,
      inject: (source) => ({
        content: `${source}${source.endsWith('\n') ? '' : '\n'}${CANARY_INVALID_LINE}\n`,
        testId: CANARY_INVALID_LINE,
        matches: () => true,
      }),
    });
    if (outcome.run.exitCode !== 0 || outcome.run.timedOut) {
      return {
        status: CanaryStatus.KILLED,
        grade: 'exit-code',
        target,
        detail: `the gate command exited ${outcome.run.exitCode} with an unparseable line injected into ${target}`,
      };
    }
    if (outcome.run.truncated) {
      // Direction (FAILED) is unaffected -- exit code is unaffected by output
      // capture -- but "does not exercise the code" would be the wrong REASON: a
      // reader would go hunting a coverage gap instead of a capture-limit issue.
      return {
        status: CanaryStatus.FAILED,
        grade: 'exit-code',
        target,
        detail: `the gate command's output was truncated at the capture limit while exiting 0 with an `
          + `unparseable line injected into ${target} -- no verdict from it is interpretable`,
      };
    }
    return {
      status: CanaryStatus.FAILED,
      grade: 'exit-code',
      target,
      detail: `the gate command still exited 0 with an unparseable line injected into ${target}, so it `
        + 'does not actually exercise the code being mutated -- no verdict from it is interpretable',
    };
  }

  // --- counted grade (everything that is not exit-code) --------------------
  // Before any target is discovered: an adapter with no canary() cannot fire on
  // any of them, and `inject` below would be null. `execute()` refuses this
  // earlier, so reaching it here means a direct caller -- including one whose
  // adapter has no valid grade at all, which lands in this branch and would
  // otherwise throw rather than report.
  const prerequisite = canaryPrerequisiteFailure(adapter);
  if (prerequisite) return prerequisite;

  const targets = discoverCanaryTargets({
    workspaceRoot: workspace.root, repoRoot: config.repoRoot, adapter, preferredFiles,
  });
  if (!targets.length) {
    return {
      status: CanaryStatus.FAILED,
      grade: 'counted',
      target: null,
      detail: `cannot synthesise a canary: no tracked file matches the ${adapter.name} adapter's test `
        + `patterns (${(adapter.testFilePatterns ?? []).join(', ') || 'none declared'}). `
        + 'Without a canary the gates cannot establish that this command observes failures at all.',
    };
  }

  // Candidates are tried in order, because a file matching the adapter's test
  // glob is not necessarily inside THIS command's scope -- a project whose
  // baselineCommand names specific files is normal. Establishing that the harness
  // observes a deliberate break in any one file is what the gate is for; failing
  // on the first candidate that happens to sit outside the scope would block
  // every review on a correctly configured project.
  const attempts = [];
  const declined = [];
  for (const target of targets) {
    if (attempts.length - declined.length >= MAX_CANARY_ATTEMPTS) break;
    if (declined.length >= MAX_CANARY_DECLINES) break;
    const outcome = await runCanaryOnce({
      config, adapter, workspace, command, target, inject: adapter.canary, deadlineMs,
    });
    if (!outcome) {
      // No command ran, so this attempt cost nothing measurable -- but it still
      // carries the field, so a reader summing `attempts` never has to special-case
      // a missing one.
      //
      // Neither stopping the walk nor charging MAX_CANARY_ATTEMPTS: canary() may
      // legally decline a FILE (an unfamiliar dialect, a generated fixture) while
      // handling the next candidate, and every adapter that can never synthesise
      // one at all is already refused above. A decline that ended the walk -- or
      // spent the suite-run budget -- would fail the gate on a harness that
      // establishes it one candidate later.
      declined.push(target);
      attempts.push({ target, durationMs: 0, why: `the ${adapter.name} adapter declined to synthesise a canary test for this file` });
      continue;
    }

    const { parsed, run, injected } = outcome;

    // INTERPRETATION, stated in the plan: the design says the canary must "come
    // back KILLED". A compile break classifies as IMPRECISE, not KILLED, so it
    // does NOT satisfy this gate -- it is never generously counted as a kill.
    // Fail-safe by construction: the canary cannot pass by accident, and a stack
    // whose injection does not compile is told exactly that instead of silently
    // downgrading the precision of every verdict in the run.
    if (parsed.compileError) {
      attempts.push({
        target,
        durationMs: run.durationMs,
        why: `the injected canary produced a compile/parse break rather than a named test failure, so `
          + 'precision cannot be established from it',
      });
      continue;
    }

    if (parsed.failed === 0) {
      attempts.push({
        target,
        durationMs: run.durationMs,
        why: `a guaranteed-failing test was injected and the command still reported no failures `
          + `(${parsed.ran} test(s) ran, exit ${run.exitCode}) -- it does not observe failures in that file`,
      });
      continue;
    }

    const matched = parsed.failedTests.filter((failure) => injected.matches(failure));
    if (parsed.failed !== 1 || matched.length !== 1) {
      attempts.push({
        target,
        durationMs: run.durationMs,
        why: `expected exactly the injected canary to fail, but ${parsed.failed} failure(s) were reported: `
          + `${parsed.failedTests.map((f) => f.id).join(', ') || '(none named)'}`,
      });
      continue;
    }

    return {
      status: CanaryStatus.KILLED,
      grade: 'counted',
      target,
      attempts,
      detail: `the synthesised canary ${injected.testId} was the single observed failure, then discarded`,
    };
  }

  // `target` names where a command actually ran, never a declined candidate: the
  // report renders it as "via <target>", which would otherwise point at a file
  // nothing was ever injected into.
  const declinedTargets = new Set(declined);
  const measured = attempts.filter((a) => !declinedTargets.has(a.target));
  const parts = [
    'no synthesised canary fired, so this command cannot be shown to observe failures at all.',
    'Every mutant would read SURVIVED and every finding would be false.',
    measured.length
      ? `Tried: ${measured.map((a) => `${a.target} (${a.why})`).join('; ')}.`
      : 'No candidate was ever injected into.',
  ];
  if (declined.length) {
    parts.push(`${declined.length} candidate${declined.length === 1 ? ' was' : 's were'} declined by the `
      + `${adapter.name} adapter without running anything: `
      + `${declined.slice(0, 3).join(', ')}${declined.length > 3 ? ', ...' : ''}.`);
  }
  // Either cap can leave candidates untried, and the counts above cannot say so
  // on their own: "50 declined" reads identically whether there were exactly 50
  // candidates or 300 with the real tests further down the sort.
  if (attempts.length < targets.length) {
    parts.push(`Stopped after ${attempts.length} of ${targets.length} candidates (caps: `
      + `${MAX_CANARY_ATTEMPTS} measured, ${MAX_CANARY_DECLINES} declined), so the rest were never `
      + 'tried -- narrow testFilePatterns if the real tests are among them.');
  }
  return {
    status: CanaryStatus.FAILED,
    grade: 'counted',
    target: measured.length ? measured[measured.length - 1].target : null,
    attempts,
    detail: parts.join(' '),
  };
}

export async function runBaselineGate({ config, adapter, workspace }) {
  const outcome = await measure({ command: config.baselineCommand, config, adapter, workspace });
  if (outcome.hookFailure) {
    return {
      green: false,
      command: config.baselineCommand,
      run: outcome.run,
      parsed: outcome.parsed,
      durationMs: outcome.run.durationMs,
      timedOut: outcome.run.timedOut,
      detail: `the ${outcome.hookFailure.phase} hook failed (exit ${outcome.hookFailure.run.exitCode})`,
    };
  }
  const green = isGreen(outcome);
  // Named ids when the adapter can produce them at all (exit-code grade never
  // can -- lib/adapters/exit-code.mjs always reports failedTests: []). Below
  // that, `[]` is reserved for a genuinely green baseline, where "nothing
  // failed" is the accurate reading; a FAILED baseline with nothing nameable
  // (a crash, a hook error, a bail before any test reported -- parsed.failed
  // === 0 but the exit code still says non-zero) reports `null`, never `[]`,
  // so an empty list can never be misread as "nothing failed" when the truth
  // is "cannot be named".
  const namedFailures = outcome.parsed && outcome.parsed.grade !== 'exit-code'
    ? outcome.parsed.failedTests.map((t) => t.id)
    : null;
  return {
    green,
    command: config.baselineCommand,
    run: outcome.run,
    parsed: outcome.parsed,
    counts: outcome.parsed ? {
      passed: outcome.parsed.passed, failed: outcome.parsed.failed, skipped: outcome.parsed.skipped, ran: outcome.parsed.ran,
    } : null,
    failedTests: !green && (!namedFailures || namedFailures.length === 0) ? null : namedFailures,
    durationMs: outcome.run.durationMs,
    // Machine-readable, so a hang at the gate is attributable to the SUITE
    // without a reader parsing `detail` prose for the word "timed out".
    timedOut: outcome.run.timedOut,
    detail: green ? 'baseline is green' : describeNotGreen(outcome),
  };
}

// Per-scope narrow baseline, memoised by the FULLY RESOLVED command string so
// mutants sharing a scope pay one extra run between them.
//
// The measurement makes the report's delta auditable rather than asserted: the
// global baseline runs the whole suite while a mutant runs a narrowed scope, so
// comparing those two would show the narrowing, not the mutation.
//
// The other half is the important half: a narrow scope that is non-green or runs
// ZERO TESTS fails its mutant as ERROR, never SURVIVED. A zero-test scope
// reporting SURVIVED would manufacture exactly the false finding the canary gate
// exists to prevent, one level down.
export function createNarrowBaselineCache({ config, adapter, workspace }) {
  const cache = new Map();
  return {
    async get(command) {
      if (!cache.has(command)) {
        cache.set(command, (async () => {
          const outcome = await measure({ command, config, adapter, workspace });
          const green = !outcome.hookFailure && isGreen(outcome);
          return {
            command,
            green,
            run: outcome.run,
            parsed: outcome.parsed,
            counts: outcome.parsed ? {
              passed: outcome.parsed.passed,
              failed: outcome.parsed.failed,
              skipped: outcome.parsed.skipped,
              ran: outcome.parsed.ran,
            } : null,
            durationMs: outcome.run.durationMs,
            timedOut: outcome.run.timedOut,
            detail: outcome.hookFailure
              ? `the ${outcome.hookFailure.phase} hook failed (exit ${outcome.hookFailure.run.exitCode})`
              : (green ? 'narrow scope is green' : describeNotGreen(outcome)),
          };
        })());
      }
      return cache.get(command);
    },
    size() { return cache.size; },
    // One record per DISTINCT scope, which is what makes the memoisation visible
    // in the report rather than only asserted in a comment: N mutants sharing a
    // scope produce one entry here, not N.
    async entries() { return Promise.all([...cache.values()]); },
  };
}
