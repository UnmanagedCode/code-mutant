// Per-mutant orchestration: resolve, gate, apply, run, classify, restore.
//
// Split into two phases on purpose:
//
//   Phase A runs entirely against an UNMUTATED tree -- baseline gate, site
//   resolution, narrowing plans, every per-scope narrow baseline, and then the
//   canary gate. Measuring a narrow baseline lazily would be a correctness bug
//   under --jobs: worker 2 could measure "unmutated" while worker 1 has a
//   mutation applied to the same copy.
//
//   The canary comes AFTER the narrow baselines because it now runs the commands
//   that judge mutants (lib/canary-gate.mjs): it needs each scope proven green
//   and non-empty, and it needs that scope's durationMs as its like-for-like
//   deadline reference. It still precedes every applyResolved, so it can never
//   inject on top of an applied mutation.
//
//   Phase B applies mutations, one workspace per WORKER ORDINAL -- never per item
//   index, which is only an ordinal for the first `jobs` items (see pool below).
//   In-place is always single-worker.
//
// The previous version of this comment said "in copy mode each worker owns its own
// copy, so nothing is shared", and the code below did not implement that. Cards
// 2026-0010 and 2026-0029. So the ownership is now asserted rather than argued:
// every workspace carries an occupancy lease and a residue ledger
// (lib/occupancy.mjs), and lib/mutant-run.mjs turns a violation of either -- plus
// a mutation that did not survive its own measured run -- into ERROR. Never a
// verdict, because the race that produced a false SURVIVED in the field produces a
// false KILLED just as easily and in silence.

import { establishCanary, needsNarrowCanary, skippedCanaryRecord } from './canary-gate.mjs';
import { MUTATION_DIR, mutationDirIsIgnored } from './catalog.mjs';
import { configFingerprint } from './fingerprint.mjs';
import {
  GATE_CACHE_SCHEMA_VERSION, gateCacheKey, gateCachePath, harnessFingerprint, readGateEntry,
  runtimeFingerprint, treeDigest, writeGateEntry,
} from './gate-cache.mjs';
import {
  CanaryStatus, GateOutcome, canaryPrerequisiteFailure, checkBaseDiffGate, checkCleanTree,
  createNarrowBaselineCache, headSha, runBaselineGate,
} from './gates.mjs';
import { acquireInPlaceLock } from './inplace-lock.mjs';
import { journalKey, mutantFingerprint, openJournal, readJournal } from './journal.mjs';
import { errorResult, runMutant } from './mutant-run.mjs';
import { planNarrowing } from './narrow.mjs';
import { SiteError, resolveSites } from './sites.mjs';
import { assertNoTraceAcross, openWorkspace } from './workspace.mjs';

export { GateOutcome };

// `fn` receives the WORKER ORDINAL as well as the item index, and the two are
// different things: the ordinal identifies which of the `size` concurrent workers
// is calling, and is therefore the only safe key for anything a worker owns
// exclusively. The item index is not -- it only coincides with an ordinal for the
// first `size` items, after which whichever worker finishes first takes the next
// item and carries an index that belongs to no particular worker.
//
// Keying a workspace on the item index is what produced cards 2026-0010 and
// 2026-0029: two mutants in one copy at once, interleaved snapshot and restore,
// and verdicts (a SURVIVED and an IMPRECISE) that a serial re-run contradicted.
//
// Exported for test/occupancy.test.mjs, which pins the ordinal invariant here
// rather than only through the runner.
export async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(size, items.length));
  const workers = Array.from({ length: width }, async (_slot, ordinal) => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index, ordinal);
    }
  });
  await Promise.all(workers);
  return results;
}

// Derived, never accumulated: every component is already on the report, so the
// breakdown cannot drift out of step with the numbers it sums.
//
// `mutantsMs` is a SUM of per-mutant wall clocks, so under `jobs > 1` it exceeds
// `totalMs` -- that is the correct reading (total CPU-time spent on mutants),
// and the cost breakdown this exists for is measured at `jobs: 1`.
function deriveTimings(report, totalMs) {
  const sum = (list, pick) => list.reduce((acc, item) => acc + (pick(item) ?? 0), 0);
  return {
    totalMs,
    gatesMs: (report.gates?.baseline?.durationMs ?? 0) + (report.gates?.canary?.durationMs ?? 0),
    narrowBaselinesMs: sum(report.narrowBaselines ?? [], (b) => b.durationMs),
    mutantsMs: sum(report.results ?? [], (r) => r.durationMs),
  };
}

// WHAT THE GATE CACHE IS AND IS NOT, since it overturns a contract this project
// stated plainly until now ("resume never skips a gate").
//
// The REASON behind that contract still holds: a gate that did not run this
// invocation must never read as one that passed -- the ambiguity
// `not-established` exists to prevent. A hit is not that. It is a MEASUREMENT
// keyed on the tree it was made against: byte-exact worktree content, the
// resolved commands, the adapter, the isolation mode, the harness's own source
// and the runtime. Its outcome is served verbatim, `fromCache: true` beside it
// on every channel, so it can never be mistaken for a gate established here.
//
// The distinction resume itself still turns on: resume reuses a VERDICT, a
// graded claim about a mutant, and its gates are re-established every invocation
// regardless because a verdict's trustworthiness rests on gates that held for
// THIS tree. The gate cache reuses a MEASUREMENT, and only against the tree it
// measured.
// Null when the tree cannot be keyed at all -- see treeDigest. The caller turns
// that into a forced miss that also writes nothing: an entry filed under a key
// that cannot distinguish its own tree is the false hit, not the cure for one.
function gateCacheInputs({ config, report }) {
  const tree = treeDigest(config.repoRoot);
  if (tree.digest === null) return { inputs: null, reason: tree.reason };
  return {
    inputs: {
      treeDigest: tree.digest,
      configFingerprint: configFingerprint(config),
      adapter: report.adapter,
      isolation: report.isolation,
      harnessFingerprint: harnessFingerprint(),
      runtime: runtimeFingerprint(),
    },
    reason: null,
  };
}

function readCachedGates({
  config, report, cacheKey, unkeyable, remeasureGates, log,
}) {
  const startedAt = process.hrtime.bigint();
  if (cacheKey === null) {
    report.gateCache = {
      status: 'miss',
      key: null,
      file: null,
      measuredAt: null,
      canaryMeasuredAt: null,
      measuredSha: null,
      lookupMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      wrote: false,
      writeSkipped: unkeyable,
      canaryServed: false,
      filledCanary: false,
    };
    log(`gate cache: this tree cannot be keyed (${unkeyable}) -- measuring both gates, writing nothing`);
    return null;
  }
  const entry = remeasureGates ? null : readGateEntry(config.repoRoot, cacheKey, log);
  report.gateCache = {
    status: remeasureGates ? 'bypassed' : (entry ? 'hit' : 'miss'),
    key: cacheKey,
    file: gateCachePath(config.repoRoot, cacheKey),
    // Provenance, non-null only on a hit: a reader can see the measurement came
    // from a different commit with identical content, which is legitimate and
    // otherwise invisible.
    measuredAt: entry?.measuredAt ?? null,
    // Differs from `measuredAt` only when a later hit filled an empty canary slot.
    canaryMeasuredAt: entry?.canaryMeasuredAt ?? null,
    measuredSha: entry?.measuredSha ?? null,
    // The cache's OWN cost -- the tree digest and the file read. Deliberately not
    // `timings.gatesMs`, which stays exactly "measured-command cost this
    // invocation" so the derivation identity on the report is untouched.
    lookupMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    wrote: false,
    writeSkipped: null,
    // Set below. A hit serves the BASELINE always and the canary only when the
    // entry carries one -- a narrow-scope canary is never cached, so a run that
    // narrows re-establishes it here. The report's banner keys on this rather
    // than on `status`, or it would print "the gates were served" above a canary
    // that ran in this invocation.
    canaryServed: false,
    // Set by recordGates when this hit filled the entry's empty canary slot.
    filledCanary: false,
  };
  if (remeasureGates) log('gate cache BYPASSED (--remeasure-gates): re-measuring both gates');
  return entry;
}

// `durationMs: 0` because no command ran this invocation -- the same reading
// `attempts[].durationMs: 0` already carries for a candidate the adapter
// declined. The original cost is kept as `measuredDurationMs` rather than
// replayed, so a served gate can never be read as work done here.
function serveGateRecord(record) {
  return {
    ...record,
    fromCache: true,
    measuredDurationMs: record.durationMs,
    durationMs: 0,
  };
}

// THE ONE WRITE A HIT MAY MAKE: filling an entry's empty canary slot. Without it a
// null slot -- from `baseline --no-canary`, or from a narrowing run -- is never
// filled, and every later run that cannot narrow re-pays a whole-suite canary
// each invocation. So the canary this invocation measured is filed, but only the
// kind a miss would have filed AND that attests: never over a stored canary,
// never a served one, never a skip, never narrow or mixed scope (derived from the
// catalog the key does not cover), and never anything short of KILLED.
//
// Exported for test/gate-cache.test.mjs, which pins each refusal at the unit
// level as well as through the runner.
export function canaryToFill({ cachedCanary, canary }) {
  if (cachedCanary !== null) return null;
  if (!canary) return null;
  if (canary.fromCache !== false) return null;
  if (canary.skipped) return null;
  if (canary.scope !== 'baseline') return null;
  if (canary.status !== CanaryStatus.KILLED) return null;
  return canary;
}

// Written ONLY from a run that got this far, and only when all four hold. A run
// killed mid-mutation therefore writes nothing at all: it never reaches the
// no-trace assertion. The cost of that ordering is that a crash in Phase B
// re-pays the gates next time, which is the correct trade for this harness.
function recordGates({
  config, report, cacheKey, keyInputs, cached, log,
}) {
  // No key means no entry could be filed that would ever be safe to serve;
  // readCachedGates has already recorded why.
  if (cacheKey === null) return;
  // A hit measured nothing new to record -- unless it can fill the canary slot.
  const fill = cached ? canaryToFill({ cachedCanary: cached.gates.canary, canary: report.gates.canary }) : null;
  if (cached && !fill) return;
  const skip = (why) => { report.gateCache.writeSkipped = why; };
  if (!report.noTrace?.ok) return skip('the run did not prove it left no trace');
  // Mirrors the journal's rule: a --allow-dirty run records nothing reusable.
  if (!report.reproducible) return skip('--allow-dirty: this run\'s measurements are not reproducible');
  // A PREDICATE, not the catalog module's throw: `baseline` deliberately does not
  // hard-stop on an unignored `.mutation/`, and this must not hand it a new
  // refusal. A logged degradation, not a silent one -- and leave-no-trace holds
  // either way, because the skipped write is the thing that would have left one.
  if (!mutationDirIsIgnored(config.repoRoot)) {
    return skip(`${MUTATION_DIR}/ is not gitignored, so an entry there would be a visible untracked file`);
  }
  if (fill) {
    // `cached` is the raw entry readGateEntry returned -- never the served copy --
    // and `cacheKey` is the Phase-A key it was matched against. Everything but the
    // canary half is carried over verbatim, so the baseline's provenance stays
    // the measurement it was.
    writeGateEntry(config.repoRoot, cacheKey, {
      ...cached,
      key: cacheKey,
      gates: { baseline: cached.gates.baseline, canary: fill },
      canaryMeasuredAt: new Date().toISOString(),
    });
    report.gateCache.wrote = true;
    report.gateCache.filledCanary = true;
    log(`gate cache: filled this entry's empty canary slot with the baseline-scope canary measured here (key ${cacheKey})`);
    return undefined;
  }
  const canary = report.gates.canary?.scope === 'baseline' && !report.gates.canary.skipped
    ? report.gates.canary
    : null;
  const measuredAt = new Date().toISOString();
  writeGateEntry(config.repoRoot, cacheKey, {
    schemaVersion: GATE_CACHE_SCHEMA_VERSION,
    key: cacheKey,
    measuredAt,
    measuredSha: report.mutatedSha,
    // The Phase-A inputs verbatim, never re-derived here: a digest taken after
    // Phase B would describe a tree that was mutated and restored, and would
    // disagree with the key this entry is filed under the moment a restore
    // silently failed. Recorded so an operator asking "why did this miss?" can
    // diff two entries instead of guessing -- never read back as an authority,
    // because the filename is the key.
    keyInputs,
    // NARROW-SCOPE CANARIES ARE NEVER CACHED, BY DESIGN. The cache key excludes
    // the gitignored catalog on the stated grounds that the canary is "a property
    // of the command and not of the mutants" -- true verbatim only of the
    // baseline-scope canary, since a narrow canary is derived from the catalog and
    // two different catalogs against one tree hash to the same key. So the
    // baseline half (catalog-independent) stays cached and the canary half is
    // written as null, rather than amending the key. A skipped canary
    // (`baseline --no-canary`) measured nothing and is written as null too.
    gates: {
      baseline: report.gates.baseline,
      canary,
    },
    canaryMeasuredAt: canary ? measuredAt : null,
  });
  report.gateCache.wrote = true;
  return undefined;
}

// Wrapped so the total is one wall clock across every early return -- a failed
// gate's cost is part of what a run costs, and a breakdown that only appeared on
// the happy path could not show that.
export async function execute(args) {
  const startedAt = process.hrtime.bigint();
  const report = await executeRun(args);
  report.timings = deriveTimings(report, Number(process.hrtime.bigint() - startedAt) / 1e6);
  return report;
}

async function executeRun({
  config, adapter, mutants, log = () => {}, resultForEmptyCatalog = true,
  allowDirty = false, enforceCleanTree = true, checkBaseDiff = false, base = null, learn = false,
  resume = false, journalling = false, remeasureGates = false, skipCanary = false,
}) {
  // A graded run's verdicts are only interpretable beside a canary for the
  // commands that judged them, so a skip is refused rather than honoured.
  if (skipCanary && mutants.length) {
    throw new Error('skipCanary is for `baseline` only: every graded run establishes its own canary at the scope it grades');
  }
  const report = {
    isolation: config.isolation,
    learn,
    // Not simply `config.jobs`: in-place isolation always runs serially (workers
    // sharing one tree would restore over each other), and the report must say
    // so regardless of whether the config layer's own clamp ran -- runner.mjs
    // owns the isolation-vs-concurrency rule for its own execution, so it does
    // not trust an upstream value to already reflect it.
    jobs: config.isolation === 'in-place' ? 1 : config.jobs,
    workspaceRoot: null,
    adapter: {
      name: adapter.name,
      grade: adapter.grade,
      modulePath: adapter.modulePath ?? null,
      // Routed only: which runner judges which test files.
      ...(adapter.routes ? {
        routes: adapter.routes.map((route) => ({
          name: route.name,
          runner: route.runner,
          tests: route.tests,
          grade: route.adapter.grade,
          modulePath: route.adapter.modulePath ?? null,
        })),
      } : {}),
    },
    gates: {},
    // One entry per DISTINCT narrow scope, in the order the scopes were first
    // measured. Until now these runs were invisible in the report even though
    // they are a whole extra measured command per scope.
    narrowBaselines: [],
    timings: null,
    results: [],
    noTrace: null,
    // So a survivor is re-runnable against a sha by anyone -- the whole point of
    // the clean-tree precondition below.
    mutatedSha: headSha(config.repoRoot),
    reproducible: true,
    // { journal, key, reused, ran } when --resume was passed, else null.
    resumed: null,
    // The ADVISORY: { key, available } when a journal matches this invocation and
    // --resume was NOT passed, else null. Never a gate and never an exit-code
    // effect -- it is the only channel that reaches an actor at the moment it
    // decides to re-run, which docs do not.
    resumable: null,
    // Null until the key is computed, which is after the three unconditional
    // gates -- so a run that stopped at one of them never claims a cache state.
    gateCache: null,
  };

  // ---- Cross-process exclusion, before the clean-tree gate ---------------
  // Only in-place: copy mode gives every process its own tree, so nothing is
  // shared and nothing needs excluding.
  //
  // BEFORE clean-tree deliberately. A holder with a mutation applied has DIRTIED
  // the tree, so clean-tree would otherwise refuse first with `dirty-tree` -- a
  // refusal that names no holder and misdirects the reader into committing work
  // that is not theirs.
  //
  // The command label is for the refusal text only, and it is derived here rather
  // than threaded through mutate.mjs: `run` journals, `probe` waives the
  // clean-tree gate, and `baseline` does neither.
  let lock = null;
  if (config.isolation === 'in-place') {
    lock = acquireInPlaceLock({
      repoRoot: config.repoRoot,
      command: journalling ? 'run' : (enforceCleanTree ? 'baseline' : 'probe'),
      log,
    });
    report.gates.inPlaceLock = {
      outcome: lock.held ? GateOutcome.PASSED : GateOutcome.FAILED,
      code: lock.code,
      claimDir: lock.claimDir,
      holder: lock.holder,
      blockedBy: lock.blockedBy,
      detail: lock.detail,
    };
    if (!lock.held) {
      log(`in-place-lock FAILED: ${lock.detail}`);
      // Nothing to release: acquire withdrew its own claim before returning.
      return report;
    }
  }

  // Wrapped so EVERY exit shape releases: each early `return report` below (a
  // failed gate) and every throw passes through this finally. The signal and
  // uncaught-exception shapes are covered separately, by the cleanup the lock
  // registers for itself (lib/inplace-lock.mjs).
  try {
    // ---- The third trust gate: mutation must run against committed state ----
    // Checked before baseline and canary, and before any workspace is opened --
    // copy mode would otherwise pay for a full tree copy before refusing.
    if (enforceCleanTree) {
      const clean = checkCleanTree(config.repoRoot);
      const dirty = !clean.clean;
      report.gates.cleanTree = {
        outcome: dirty && !allowDirty ? GateOutcome.FAILED : GateOutcome.PASSED,
        code: dirty && !allowDirty ? 'dirty-tree' : null,
        dirty,
        allowedDirty: dirty && allowDirty,
        detail: !dirty
          ? 'worktree is clean'
          : (allowDirty
            ? 'worktree has uncommitted or untracked changes; proceeding under --allow-dirty -- every '
              + 'verdict from this run is non-reproducible'
            : 'worktree has uncommitted or untracked changes, so mutation would not run against committed, '
              + `re-runnable state:\n${clean.status}`),
      };
      if (dirty) {
        if (!allowDirty) {
          log(`clean-tree FAILED: ${report.gates.cleanTree.detail}`);
          return report;
        }
        // Reaching here means dirty AND allowDirty: proceeding, but non-reproducible.
        report.reproducible = false;
        log('clean-tree: dirty, proceeding under --allow-dirty (non-reproducible)');
      }
    }

    if (checkBaseDiff) {
      const baseDiff = checkBaseDiffGate(config.repoRoot, base);
      report.gates.baseDiff = baseDiff;
      if (baseDiff.outcome === GateOutcome.FAILED) {
        log(`base-diff FAILED: ${baseDiff.detail}`);
        return report;
      }
      log(`base-diff: ${baseDiff.outcome}${baseDiff.base ? ` (vs ${baseDiff.base})` : ''}`);
    }

    // ---- The canary prerequisite, before a single command or tree copy ------
    // An adapter that cannot synthesise a canary at all fails the canary gate
    // whatever else happens, and the whole cost of learning that late is the gate
    // sequence BEFORE it: one full baselineCommand run, plus a tree copy in copy
    // mode. So it is decided here, from the adapter's exports alone.
    const prerequisite = canaryPrerequisiteFailure(adapter);
    if (prerequisite) {
      report.gates.canary = {
        outcome: GateOutcome.FAILED,
        status: prerequisite.status,
        // Baseline scope by construction: no command ran at all, and the refusal is
        // about the adapter rather than about any one scope.
        scope: 'baseline',
        grade: prerequisite.grade,
        command: config.baselineCommand,
        target: prerequisite.target,
        attempts: prerequisite.attempts,
        scopes: null,
        durationMs: 0,
        detail: prerequisite.detail,
      };
      log(`canary FAILED: ${prerequisite.detail}`);
      return report;
    }

    const workspaces = [];
    const openCount = config.isolation === 'copy' ? Math.max(1, Math.min(config.jobs, Math.max(mutants.length, 1))) : 1;
    for (let i = 0; i < openCount; i += 1) {
      workspaces.push(openWorkspace({
        repoRoot: config.repoRoot,
        isolation: config.isolation,
        preserve: config.preserve,
        label: `w${i}`,
      }));
    }
    const primary = workspaces[0];
    report.workspaceRoot = primary.root;

    // The unmutated whole-suite reference the canary gate's attempts inherit.
    // Null on a cache hit, where no attempt is made at all.
    let baselineDurationMs = null;

    try {
      // ---- Phase A: gates and planning, against an unmutated tree -----------
      // ---- The gate cache, keyed against the tree AS IT STANDS NOW ----------
      // Computed ONCE, here, and never recomputed at the end of the run: a key
      // derived after Phase B would hash a tree that was mutated and restored, so
      // a restore that silently failed would file a clean-tree measurement under a
      // residue-tree key. That is the one way this feature could manufacture a
      // false hit, and the ordering removes it by construction.
      //
      // Under in-place this is necessarily the unmutated tree: Phase A precedes
      // every apply, and the clean-tree gate above has already refused a dirty one
      // for `baseline`/`run`.
      const { inputs: keyInputs, reason: unkeyable } = gateCacheInputs({ config, report });
      const cacheKey = keyInputs ? gateCacheKey(keyInputs) : null;
      const cached = readCachedGates({ config, report, cacheKey, unkeyable, remeasureGates, log });

      if (cached) {
        report.gates.baseline = serveGateRecord(cached.gates.baseline);
        // Only what is known HERE: whether the canary half is served is decided
        // below, once the pending set says whether this run needs narrow attestation.
        log(`gate cache HIT (key ${cacheKey}): baseline served from cache, measured ${cached.measuredAt}`);
        // The failed-gate branch is kept and still consulted on a served record.
        // Nothing that FAILED is ever written, so this is unreachable from an
        // entry this harness wrote -- and reachable from a hand-edited one, which
        // must stop the run rather than proceed.
        if (report.gates.baseline.outcome === GateOutcome.FAILED) {
          log(`baseline FAILED: ${report.gates.baseline.detail}`);
          return report;
        }
      } else {
        log(`baseline: ${config.baselineCommand}`);
        const baseline = await runBaselineGate({ config, adapter, workspace: primary });
        report.gates.baseline = {
          outcome: baseline.green ? GateOutcome.PASSED : GateOutcome.FAILED,
          command: baseline.command,
          counts: baseline.counts ?? null,
          exitCode: baseline.run.exitCode,
          failedTests: baseline.failedTests ?? null,
          durationMs: baseline.durationMs,
          timedOut: baseline.timedOut,
          detail: baseline.detail,
          ...(baseline.groups ? { groups: baseline.groups } : {}),
          fromCache: false,
          measuredDurationMs: null,
        };
        if (!baseline.green) {
          log(`baseline FAILED: ${baseline.detail}`);
          return report;
        }
        log(`baseline green${baseline.counts ? ` (${baseline.counts.passed} passed, ${baseline.counts.skipped} skipped, ${baseline.counts.ran} ran)` : ''}`);
        baselineDurationMs = baseline.durationMs;
      }

      // Resolve every site before anything is applied, so a stale anchor in mutant
      // 5 cannot leave mutant 4's edit sitting in the tree.
      const planned = [];
      for (const [index, mutant] of mutants.entries()) {
        try {
          const resolvedSites = resolveSites(primary.root, mutant.sites);
          const narrowing = planNarrowing({
            mutant, adapter, testCommand: config.testCommand, learn, baselineCommand: config.baselineCommand,
          });
          planned.push({ index, mutant, resolvedSites, narrowing, error: null });
        } catch (err) {
          const reason = err instanceof SiteError ? err.code : 'plan-failed';
          planned.push({ index, mutant, error: errorResult(mutant, reason, err.message) });
        }
      }

      // ---- The journal, read BEFORE the canary gate ------------------------
      // Two things need it this early: the canary-target hint below, and the
      // resume filter, which has to land before the narrow-baseline loop (see
      // there for why). Neither is the gate cache, which lives above and answers a
      // different question -- this journal reuses per-mutant VERDICTS, and its key
      // is a sha where the cache's is the tree's bytes.
      const key = journalKey({
        mutatedSha: report.mutatedSha,
        config,
        adapter,
        isolation: report.isolation,
        jobs: report.jobs,
        learn,
      });
      const existingJournal = report.mutatedSha ? readJournal(config.repoRoot, key) : null;

      // ---- THE RESUME FILTER, before any narrow baseline is measured -------
      // Ordering is the whole of AC4. Phase A measures a narrow baseline for EVERY
      // planned mutant, so filtering after that loop would reuse the verdicts and
      // still re-pay every scope -- the expensive half. A resumed mutant needs no
      // measurement at all: its journalled result carries its own
      // narrowBaseline.counts, so the report's delta still renders.
      const reusedEntries = [];
      let pending = planned;
      if (resume && existingJournal) {
        pending = [];
        for (const entry of planned) {
          const journalled = existingJournal.results.get(mutantFingerprint(entry.mutant));
          if (!journalled) { pending.push(entry); continue; }
          reusedEntries.push({
            index: entry.index,
            result: {
              ...journalled,
              // Re-read from the CURRENT catalog, never from the journal. These are
              // the three fields the fingerprint deliberately excludes -- prose and
              // decisions -- so recording a waiver costs no re-run.
              invariant: entry.mutant.invariant,
              whyNotEquivalent: entry.mutant.whyNotEquivalent ?? null,
              waived: entry.mutant.waived ?? null,
              fromJournal: true,
            },
          });
        }
      }
      if (resume) {
        report.resumed = {
          journal: existingJournal ? existingJournal.file : null,
          key,
          reused: reusedEntries.length,
          ran: pending.length,
        };
        if (reusedEntries.length) {
          log(`resume: reusing ${reusedEntries.length} journalled verdict(s), running ${pending.length}`);
        }
      } else if (existingJournal) {
        // ADVISORY ONLY. The failure mode this exists for: a reviewer times out,
        // gets re-prompted, and re-runs the same command it ran before -- never
        // learning the flag exists. Docs do not reach it at that moment.
        const available = planned
          .filter((entry) => existingJournal.results.has(mutantFingerprint(entry.mutant))).length;
        if (available) report.resumable = { key, available };
      }

      // ---- Every distinct narrow scope, measured once, up front and unmutated --
      // Only for the mutants that will actually run, and BEFORE the canary gate:
      // the canary now runs these same commands, and it needs each one proven
      // green (a canary injected into a broken scope attests nothing) and its
      // duration as a like-for-like deadline reference.
      const narrowBaselines = createNarrowBaselineCache({ config, adapter, workspace: primary });
      for (const entry of pending) {
        if (entry.error) continue;
        await narrowBaselines.get(entry.narrowing.command, entry.narrowing.scopes);
      }
      if (narrowBaselines.size()) {
        report.narrowBaselines = (await narrowBaselines.entries()).map((b) => ({
          command: b.command,
          green: b.green,
          counts: b.counts,
          durationMs: b.durationMs,
          ...(b.groups ? { groups: b.groups } : {}),
        }));
        log(`narrow baselines: ${narrowBaselines.size()} distinct scope(s)`);
      }

      // ---- The canary gate --------------------------------------------------
      // A cached entry carries a canary record only when the canary it recorded was
      // BASELINE-SCOPE: a narrow-scope canary attests about commands derived from
      // the mutant catalog, which the cache key deliberately does not cover, so it
      // is never cached (see recordGates). `canary: null` is therefore a legal entry.
      //
      // A cached record being present is NOT sufficient to serve it: `baseline`
      // files a baseline-scope canary against this very tree, and serving that to a
      // `run` whose verdicts come from a narrowed command would put the record's
      // claim and the run's verdicts on two different commands. So the pending set
      // decides, exactly as it decides which canaries the gate runs.
      const needsNarrow = needsNarrowCanary({
        pending, adapter, config, workspaceRoot: primary.root,
      });
      if (skipCanary) {
        // `baseline --no-canary`: no canary attempted, and none served either --
        // even a stored one -- so the report never claims more than this flag asked.
        report.gates.canary = skippedCanaryRecord({ adapter });
        log('canary NOT-ESTABLISHED: skipped (--no-canary) -- every graded run establishes its own canary '
          + 'at the scope it grades');
      } else if (cached && cached.gates.canary && !needsNarrow) {
        // The outcome and status are served VERBATIM: a `not-established` canary
        // stays `not-established`, never promoted to `passed`. A hit asserts "these
        // exact bytes were measured, at this time, against this sha" -- strictly
        // more than "did not run" -- and says which, so it can never be mistaken
        // for a gate this invocation established.
        report.gates.canary = serveGateRecord(cached.gates.canary);
        report.gateCache.canaryServed = true;
        log(`canary ${report.gates.canary.status} (baseline scope, served from cache)`);
        if (report.gates.canary.status === CanaryStatus.FAILED) {
          log(`canary FAILED: ${report.gates.canary.detail}`);
          return report;
        }
      } else {
        if (cached) {
          log(cached.gates.canary
            ? 'gate cache: the cached canary is baseline-scope and this run is judged by narrowed '
              + 'commands, so the canary is re-established here'
            : 'gate cache: the entry carries no canary (a narrow-scope canary is never cached, and '
              + '`baseline --no-canary` measures none), so the canary is established here');
        }
        const preferredFiles = [...new Set([
          // The journalled canary target first. This reorders BASELINE-SCOPE
          // CANDIDATES only -- the canary still runs in full and must still fire,
          // and a narrow scope needs no hint because its command names its files.
          // Measured (Part 1, S5): a gate whose early candidates sit outside the
          // command's scope spent 5.42x baselineCommand on attempts it discarded.
          ...(existingJournal?.header?.canaryTarget ? [existingJournal.header.canaryTarget] : []),
          ...pending.filter((p) => !p.error).flatMap((p) => p.narrowing.scopes),
        ])];

        const { record, refusals } = await establishCanary({
          config,
          adapter,
          workspace: primary,
          pending,
          preferredFiles,
          baselineDurationMs,
          narrowBaselines,
          log,
        });
        report.gates.canary = record;
        if (record.status === CanaryStatus.FAILED) {
          log(`canary FAILED: ${record.detail}`);
          return report;
        }
        // A mutant whose judging command was not attested is refused through the
        // channel Phase-A plan failures already use, so Phase B is untouched and
        // the result is never journalled -- it is a property of THIS invocation's
        // gate, and resume re-establishes gates every time regardless.
        for (const [entry, error] of refusals) entry.error = error;
        if (refusals.size) {
          log(`canary PARTIAL: ${refusals.size} mutant(s) refused with canary-not-established`);
        }
      }

      // Both success returns go through here, so the cache write cannot be added to
      // one path and forgotten on the other.
      const sealRun = () => {
        report.noTrace = assertNoTraceAcross(workspaces);
        recordGates({
          config, report, cacheKey, keyInputs, cached, log,
        });
        return report;
      };

      if (!mutants.length) {
        if (resultForEmptyCatalog) log('no mutants to run');
        return sealRun();
      }

      // ---- Phase B: apply, run, classify, restore ---------------------------
      // Keyed on the worker ordinal, never the item index: `width <= workspaces.length`
      // by construction, so this is a direct index with no modulo -- a modulo here is
      // what let an item index masquerade as a worker ordinal.
      // Journalled only when this run's verdicts are re-runnable against a sha. A
      // --allow-dirty run journals NOTHING: a non-reproducible verdict must never
      // become a resumable one.
      const journal = journalling && report.reproducible && report.mutatedSha
        ? openJournal({
          repoRoot: config.repoRoot,
          key,
          header: {
            mutatedSha: report.mutatedSha,
            jobs: report.jobs,
            isolation: report.isolation,
            adapter: report.adapter,
            learn,
            canaryTarget: report.gates.canary.target ?? null,
          },
        })
        : null;

      const fresh = await pool(pending, workspaces.length, async (entry, _index, ordinal) => {
        // A Phase-A plan failure cost no measured command, so it is free to
        // recompute and is never journalled.
        if (entry.error) return entry.error;
        const result = await runMutant({
          ...entry,
          config,
          adapter,
          workspace: workspaces[ordinal],
          narrowBaselines,
          learn,
        });
        // Appended only once `runMutant` has returned -- which means
        // restoreAndVerify succeeded, because a restore failure rejects instead.
        // So a journalled verdict always implies its tree was restored and proved.
        if (journal) journal.appendResult(mutantFingerprint(entry.mutant), result);
        return { ...result, fromJournal: false };
      });

      // Merged back into CATALOG order, so a resumed run's matrix reads the same as
      // a fresh one's.
      const ordered = new Array(mutants.length);
      for (const { index, result } of reusedEntries) ordered[index] = result;
      pending.forEach((entry, i) => { ordered[entry.index] = fresh[i]; });

      // Every result carries the run-level reproducibility, the same way `grade`
      // labels an exit-code kill as the weaker signal: a reader must be able to
      // tell a --allow-dirty verdict apart without cross-referencing the gates.
      report.results = ordered
        .filter(Boolean)
        .map((result) => ({ ...result, reproducible: report.reproducible }));

      return sealRun();
    } finally {
      for (const workspace of workspaces) workspace.dispose();
    }
  } finally {
    lock?.release();
  }
}

// Site path set disagreements are surfaced rather than swallowed by the union, so
// a parser bug on a patch shape neither derivation handles shows up in the report
// instead of hiding behind the safe default.
export function collectPathSetMismatches(results) {
  const notes = [];
  for (const result of results ?? []) {
    for (const site of result.mutation ?? []) {
      if (site.kind !== 'patch' || !site.pathSet || site.pathSet.agree) continue;
      notes.push({
        id: result.id,
        onlyFromGit: site.pathSet.onlyFromGit,
        onlyFromParse: site.pathSet.onlyFromParse,
        explainedByRename: site.pathSet.mismatchExplainedByRename,
        snapshotted: site.pathSet.paths,
      });
    }
  }
  return notes;
}
