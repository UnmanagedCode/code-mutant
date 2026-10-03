// THE CANARY GATE, OVER THE COMMANDS THAT ACTUALLY JUDGE MUTANTS.
//
// In counted mode no mutant verdict is derived from `baselineCommand`: every
// verdict comes from `narrowing.command` (lib/mutant-run.mjs) and every delta
// from that scope's narrow baseline. A run-level canary against
// `baselineCommand` therefore attested a property of a command that produces no
// verdict. This module runs it against each judging command instead, which is
// the DIRECT form of the proposition the baseline scope could only proxy -- and
// it is better targeted, because a NarrowMode.FILE command literally names its
// scope files, so the injected canary is inside the command's scope by
// construction and no candidate walk is needed.
//
// What it does NOT attest is anything about `baselineCommand`. That is
// acceptable precisely because nothing is judged by it -- and the vacuously
// green baseline it might be thought to cover is already refused by `isGreen`
// (lib/measure.mjs), which requires `ran > 0` at the baseline and at every
// narrow scope.
//
// FAIL CLOSED: anything this module cannot attest narrowly falls back to the
// baseline-scope canary, which runs exactly as it always did. And the wholesale
// gate failure is NARROWED, never removed: a run where nothing at all could be
// attested is still FAILED, exit 2, no verdicts.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { CanaryStatus, GateOutcome, runCanaryGate } from './gates.mjs';
import { errorResult } from './mutant-run.mjs';
import { NarrowMode } from './narrow.mjs';

// The reason a refused mutant carries. Already in DYNAMIC_UNGRADED_REASONS
// (lib/classify.mjs), which is what keeps it out of the graded shape.
export const CANARY_NOT_ESTABLISHED = 'canary-not-established';

// Why a narrow scope was not attested even though its mutants are eligible.
export const NARROW_BASELINE_NOT_GREEN = 'narrow-baseline-not-green';

// Why a whole canary record was not attempted: `baseline --no-canary`.
export const CANARY_SKIPPED = 'no-canary';

// A mutant's narrowing is narrow-canary-eligible only when ALL of these hold.
// Each one names a CORRECT harness that a looser rule would wrongly fail:
//
//   grade !== 'exit-code'  -- exit-code narrowing is WHOLE and its canary is
//     already established lazily per mutant, against the mutant's own site file.
//   mode === FILE          -- the load-bearing exclusion is NAMES: substitute()
//     prepends `--test-name-pattern ^(expectFail…)$`, which excludes the injected
//     canary's synthesised label BY CONSTRUCTION, so a narrow canary there would
//     report FAILED on a perfectly good harness. COMMAND (a per-mutant
//     narrowCommand) and WHOLE are excluded for the same class of reason: neither
//     names a file this gate could prove is in scope.
//   refsNameFiles          -- the adapter's own declaration that scopeOf(ref)
//     yields a repo file path. dotnet returns a declaring TYPE; a custom parser
//     that overrides scopeOf defaults to false. Keyed on the documented
//     interface, never on an incidental existsSync filter, so an adapter whose
//     type name happens to collide with a path is not silently narrowed.
//   command !== baselineCommand -- the --learn no-refs fallback resolves to the
//     whole suite, which IS the baseline scope.
//   placeholder                 -- `{tests}` was actually substituted, which is
//     what makes "the command names its scope files" true rather than assumed. A
//     testCommand without the placeholder runs the same thing for every mutant,
//     so the injected canary may sit outside it exactly as an out-of-scope
//     baseline candidate can -- and there is no next candidate to fall through to.
//   at least one scope file present -- a ref naming a file not in this tree.
export function narrowCanaryEligible({ narrowing, adapter, config, workspaceRoot }) {
  if (adapter.grade === 'exit-code') return false;
  if (!narrowing || narrowing.mode !== NarrowMode.FILE) return false;
  if (adapter.refsNameFiles !== true) return false;
  if (narrowing.placeholder !== true) return false;
  if (narrowing.command === config.baselineCommand) return false;
  return scopeFiles(narrowing.scopes, workspaceRoot).length > 0;
}

// Whether this run has any mutant that needs NARROW attestation, asked by the
// runner BEFORE it serves a cached canary. An entry written by `mutate.mjs
// baseline` carries a legitimately cacheable baseline-scope record; serving it to
// a `run` whose verdicts come from a different command entirely would reinstate,
// through the cache door, exactly the proxy this gate exists to remove -- a
// SURVIVED published beside a canary record that attests about a command no
// verdict came from. "Narrow-scope canaries are never cached" is an invariant on
// the SERVE side as much as the write side.
//
// The same predicate `establishCanary` partitions on, so the two cannot disagree
// about which mutants are eligible.
export function needsNarrowCanary({ pending, adapter, config, workspaceRoot }) {
  return pending.some((entry) => !entry.error && narrowCanaryEligible({
    narrowing: entry.narrowing, adapter, config, workspaceRoot,
  }));
}

function scopeFiles(scopes, workspaceRoot) {
  return [...new Set(scopes ?? [])].filter((rel) => existsSync(path.resolve(workspaceRoot, rel)));
}

function attested(unit) {
  return unit.status === CanaryStatus.KILLED;
}

// NOT-ESTABLISHED is its own outcome, never PASSED: rendering it as passed would
// claim, at the reporting layer, a property (the gate observing failures) that
// was never established at the measuring layer -- exactly the class of error this
// project exists to catch. PARTIAL is likewise its own outcome rather than either
// of the two it sits between.
function outcomeFor(status) {
  if (status === CanaryStatus.FAILED) return GateOutcome.FAILED;
  if (status === CanaryStatus.NOT_ESTABLISHED) return GateOutcome.NOT_ESTABLISHED;
  if (status === CanaryStatus.PARTIAL) return GateOutcome.PARTIAL;
  return GateOutcome.PASSED;
}

// The baseline-scope record, byte-for-byte what this gate has always produced,
// plus the three fields that say which scope it is about. Kept as its own return
// so every existing baseline-path claim stays a claim about the same code.
function baselineRecord({ config, canary }) {
  return {
    outcome: outcomeFor(canary.status),
    status: canary.status,
    scope: 'baseline',
    grade: canary.grade,
    command: config.baselineCommand,
    target: canary.target,
    attempts: canary.attempts ?? [],
    scopes: null,
    durationMs: canary.durationMs,
    detail: canary.detail,
    skipped: null,
    fromCache: false,
    measuredDurationMs: null,
  };
}

// The record `baseline --no-canary` reports in place of a canary. NOT-ESTABLISHED,
// never PASSED, for the same reason outcomeFor gives. `scope: null` keeps it out
// of the gate cache's baseline-scope write path by construction, and `command:
// null` because it attests about no command at all.
export function skippedCanaryRecord({ adapter }) {
  return {
    outcome: GateOutcome.NOT_ESTABLISHED,
    status: CanaryStatus.NOT_ESTABLISHED,
    scope: null,
    grade: adapter.grade ?? null,
    command: null,
    target: null,
    attempts: [],
    scopes: null,
    durationMs: 0,
    detail: 'not attempted: `baseline --no-canary` skipped it, so this record attests nothing about any '
      + 'command. Every graded `run` establishes its own canary at the scope it grades.',
    skipped: CANARY_SKIPPED,
    fromCache: false,
    measuredDurationMs: null,
  };
}

function describe(unit) {
  return `${unit.command}: ${unit.detail}`;
}

// `pending` is the planned entries that will actually be measured (post-resume
// filter). Returns the gate record plus, for a PARTIAL gate, one ERROR result per
// mutant whose judging command was not attested -- keyed by planned entry, so the
// runner attaches each to the channel Phase-A plan failures already use.
export async function establishCanary({
  config, adapter, workspace, pending, preferredFiles = [], baselineDurationMs = null,
  narrowBaselines, log = () => {},
}) {
  const runnable = pending.filter((entry) => !entry.error);
  const eligible = [];
  const unnarrowable = [];
  for (const entry of runnable) {
    const ok = narrowCanaryEligible({
      narrowing: entry.narrowing, adapter, config, workspaceRoot: workspace.root,
    });
    (ok ? eligible : unnarrowable).push(entry);
  }

  // An empty `pending` -- `baseline`, an empty catalog, a fully resumed run --
  // needs the baseline scope too: there is no judging command to attest, and a
  // run that established nothing at all must not read as one that did.
  const needBaseline = unnarrowable.length > 0 || runnable.length === 0;

  const groups = new Map();
  for (const entry of eligible) {
    if (!groups.has(entry.narrowing.command)) groups.set(entry.narrowing.command, []);
    groups.get(entry.narrowing.command).push(entry);
  }

  let baseline = null;
  if (needBaseline) {
    log('canary: synthesising a guaranteed-failing test');
    baseline = await runCanaryGate({
      config,
      adapter,
      workspace,
      command: config.baselineCommand,
      preferredFiles,
      scope: 'baseline',
      // The gate re-runs `baselineCommand`, which was just measured unmutated, so
      // every attempt inherits that duration as its reference instead of each one
      // costing the full ceiling.
      referenceMs: baselineDurationMs,
    });
    log(`canary ${baseline.status}${baseline.target ? ` (via ${baseline.target})` : ''}`);
  }

  const scopes = [];
  for (const [command, entries] of groups) {
    const mutants = entries.map((entry) => entry.mutant.id);
    // Measured already, in the narrow-baseline loop this gate now runs after. A
    // non-green scope ERRORs its own mutants (scope-non-green / scope-empty /
    // scope-timed-out) before any verdict, so injecting into it would attest
    // nothing and could not be told apart from the breakage.
    const narrowBaseline = await narrowBaselines.get(command);
    if (!narrowBaseline.green) {
      scopes.push({
        command,
        target: null,
        status: null,
        grade: adapter.grade ?? null,
        attempts: [],
        durationMs: 0,
        detail: `not attempted: ${narrowBaseline.detail} -- every mutant in this scope already ERRORs `
          + 'on the scope itself, so a canary here could attest nothing',
        mutants,
        skipped: NARROW_BASELINE_NOT_GREEN,
      });
      log(`canary: not attempted for ${command} (its narrow baseline is not usable)`);
      continue;
    }
    const candidates = scopeFiles(entries.flatMap((entry) => entry.narrowing.scopes), workspace.root);
    log(`canary: synthesising a guaranteed-failing test in ${command}`);
    const gate = await runCanaryGate({
      config,
      adapter,
      workspace,
      command,
      candidates,
      scope: 'narrow',
      // Like-for-like: the same command, measured unmutated moments ago.
      referenceMs: narrowBaseline.durationMs,
    });
    scopes.push({
      command,
      target: gate.target ?? null,
      status: gate.status,
      grade: gate.grade,
      attempts: gate.attempts ?? [],
      durationMs: gate.durationMs,
      detail: gate.detail,
      mutants,
      skipped: null,
    });
    log(`canary ${gate.status} for ${command}${gate.target ? ` (via ${gate.target})` : ''}`);
  }

  if (!scopes.length) {
    return { record: baselineRecord({ config, canary: baseline }), refusals: new Map() };
  }

  const units = [
    ...(baseline ? [{
      command: config.baselineCommand, status: baseline.status, detail: baseline.detail, entries: unnarrowable,
    }] : []),
    ...scopes.filter((scope) => !scope.skipped).map((scope) => ({
      command: scope.command,
      status: scope.status,
      detail: scope.detail,
      entries: groups.get(scope.command),
    })),
  ];
  const fired = units.filter(attested);
  const unattested = units.filter((unit) => !attested(unit));
  const notAttempted = scopes.filter((scope) => scope.skipped).length;

  let status;
  let detail;
  if (!units.length) {
    // Nothing needed attesting: every narrowed scope's own baseline is unusable,
    // so every mutant ERRORs on its scope. Never `passed`.
    status = CanaryStatus.NOT_ESTABLISHED;
    detail = `no canary could be attempted: all ${notAttempted} narrowed scope(s) have a narrow baseline `
      + 'that is not usable, so every mutant ERRORs on its own scope rather than being judged';
  } else if (!fired.length) {
    // Today's wholesale behaviour, preserved: exit 2, no verdicts.
    status = CanaryStatus.FAILED;
    detail = 'no command that judges a mutant could be shown to observe a deliberate break in its own '
      + `scope. ${unattested.map(describe).join(' || ')}`;
  } else if (fired.length === units.length) {
    status = CanaryStatus.KILLED;
    detail = `every command that judges a mutant was shown to observe a deliberate break in its own `
      + `scope (${units.length} attested${notAttempted ? `, ${notAttempted} not attempted` : ''})`;
  } else {
    status = CanaryStatus.PARTIAL;
    const refused = unattested.reduce((sum, unit) => sum + unit.entries.length, 0);
    // The commands only: every unattested one carries its own reason on
    // `scopes[]` and on each refused mutant, and repeating it here three times is
    // what makes a partial gate unreadable in the printed report.
    detail = `${fired.length} of ${units.length} command(s) that judge a mutant were shown to observe a `
      + `deliberate break in their own scope; ${refused} mutant(s) were ERRORed with `
      + `${CANARY_NOT_ESTABLISHED} rather than judged by an unattested command. Not attested: `
      + `${unattested.map((unit) => unit.command).join('; ')}`;
  }

  const refusals = new Map();
  if (status === CanaryStatus.PARTIAL) {
    for (const unit of unattested) {
      for (const entry of unit.entries) {
        refusals.set(entry, errorResult(
          entry.mutant,
          CANARY_NOT_ESTABLISHED,
          'the command that would judge this mutant could not be shown to observe a deliberate break in '
          + `its own scope, so no verdict from it is interpretable: ${unit.detail} `
          + `(command: ${unit.command})`,
        ));
      }
    }
  }

  return {
    record: {
      outcome: outcomeFor(status),
      status,
      scope: baseline ? 'mixed' : 'narrow',
      // Every scope here is counted grade by construction (exit-code grade is
      // never eligible), so one grade describes the whole record.
      grade: baseline ? baseline.grade : scopes[0].grade,
      // Null at pure narrow scope: no part of this gate ran `baselineCommand`,
      // and naming it would claim an attestation that was never made.
      command: baseline ? config.baselineCommand : null,
      target: baseline ? baseline.target : null,
      attempts: baseline ? (baseline.attempts ?? []) : [],
      scopes,
      durationMs: (baseline?.durationMs ?? 0) + scopes.reduce((sum, s) => sum + s.durationMs, 0),
      detail,
      skipped: null,
      fromCache: false,
      measuredDurationMs: null,
    },
    refusals,
  };
}
