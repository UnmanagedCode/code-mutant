// The gates' route scope: which routes a routed invocation's baseline and
// baseline-scope canary run.
//
// In counted mode no verdict comes from the baseline gate. Each comes from a
// mutant's narrowed command, which runs only `narrowing.routes` and carries its
// own narrow baseline and canary. A route no mutant's command runs can therefore
// change no verdict, and the gates leave it out. That holds only where a
// mutant's routes are known before anything runs, so any mutant whose routes are
// not -- a per-mutant narrowCommand, the --learn no-refs fallback, a mutant that
// fails to plan -- gates every non-opt-in route, exactly as an unrouted reading
// of the harness would. The full table is "The gates' route scope" in
// mutants.schema.md.

import { planNarrowing } from './narrow.mjs';
import { OPT_IN, baselineRoutes, compileRoutedCommand, skippedRoutes } from './routing.mjs';

export const GateScopeReason = {
  MUTANTS: 'mutants',
  ROUTE_FLAG: 'route-flag',
  NO_MUTANTS: 'no-mutants',
  UNSCOPABLE_MUTANT: 'unscopable-mutant',
  OPT_IN_ONLY: 'opt-in-only',
  WHOLE_CACHE_ENTRY: 'whole-cache-entry',
};

// `baseline --route <name> ...`, validated: null when none was given, else the
// named routes, deduped, in declared order.
export function requestedGateRoutes(adapter, names) {
  if (!names?.length) return null;
  if (!adapter.routes) {
    throw new Error('--route only applies to a harness with "routes" in config.json -- this one has a single runner');
  }
  const gateable = baselineRoutes(adapter.routes).map((route) => route.name);
  for (const name of names) {
    const route = adapter.routes.find((candidate) => candidate.name === name);
    if (!route) {
      throw new Error(`--route ${JSON.stringify(name)}: no such route; the gates can run ${gateable.join(', ')}`);
    }
    if (route.optIn === true) {
      throw new Error(`--route ${JSON.stringify(name)}: an opt-in route has no baselineCommand, so the gates never `
        + `run it; the gates can run ${gateable.join(', ')}`);
    }
  }
  return gateable.filter((name) => names.includes(name));
}

// Why `narrowing` does not show statically which routes it runs, or null.
function unscopable(narrowing, config) {
  if (!Array.isArray(narrowing.routes)) {
    return `its ${narrowing.mode} command names no routes (a per-mutant narrowCommand, or --learn with no refs)`;
  }
  if (narrowing.command === config.baselineCommand) return 'its command is the whole baselineCommand';
  return null;
}

// `{ routes, reason, detail }`; `routes: null` is the whole harness. Routed
// harnesses only. `requested` is requestedGateRoutes' answer, for `baseline`.
export function deriveGateScope({
  adapter, config, mutants, learn = false, requested = null,
}) {
  const all = baselineRoutes(adapter.routes).map((route) => route.name);
  const whole = (reason, detail) => ({ routes: null, reason, detail });
  const scoped = (names, reason, detail) => (names.length === all.length
    ? whole(reason, 'every non-opt-in route')
    : { routes: names, reason, detail });

  if (requested) return scoped(requested, GateScopeReason.ROUTE_FLAG, 'named by --route');
  if (!mutants.length) return whole(GateScopeReason.NO_MUTANTS, 'no mutants to scope by: every non-opt-in route');

  const run = new Set();
  for (const mutant of mutants) {
    // Exactly the arguments lib/runner.mjs plans with, so the two cannot disagree.
    let narrowing;
    try {
      narrowing = planNarrowing({
        mutant, adapter, testCommand: config.testCommand, learn, baselineCommand: config.baselineCommand,
      });
    } catch (err) {
      return whole(GateScopeReason.UNSCOPABLE_MUTANT, `mutant ${mutant.id} does not plan (${err.message}): every non-opt-in route`);
    }
    const why = unscopable(narrowing, config);
    if (why) return whole(GateScopeReason.UNSCOPABLE_MUTANT, `mutant ${mutant.id}: ${why}: every non-opt-in route`);
    for (const name of narrowing.routes) run.add(name);
  }
  const names = all.filter((name) => run.has(name));
  if (!names.length) {
    return whole(GateScopeReason.OPT_IN_ONLY, 'every mutant runs only opt-in routes: every non-opt-in route');
  }
  return scoped(names, GateScopeReason.MUTANTS, 'the routes this invocation\'s mutants run');
}

// What the gates run at `routes` (deriveGateScope's answer).
export function resolveGates({ adapter, config, routes }) {
  if (!adapter.routes) {
    return { baselineCommand: config.baselineCommand, routes: null, skippedRoutes: [], gateRoutes: null };
  }
  if (!routes) {
    return {
      // Already compiled by loadHarness, so a whole-harness gate is byte-identical
      // to an unscoped one: same command, same cache key.
      baselineCommand: config.baselineCommand,
      routes: baselineRoutes(adapter.routes),
      skippedRoutes: skippedRoutes(adapter),
      gateRoutes: null,
    };
  }
  const gated = baselineRoutes(adapter.routes).filter((route) => routes.includes(route.name));
  return {
    baselineCommand: compileRoutedCommand(gated.map((route) => [route.name, route.baselineCommand])),
    routes: gated,
    skippedRoutes: skippedRoutes(adapter, routes),
    gateRoutes: gated.map((route) => route.name),
  };
}

// Guards the derivation and the runner's own plan against drifting apart: a
// scoped gate must cover every non-opt-in route a planned command runs.
export function assertGatesCover({ gates, planned, config }) {
  if (!gates.gateRoutes) return;
  const gatedNames = new Set(gates.gateRoutes);
  const optIn = new Set(gates.skippedRoutes.filter((skip) => skip.reason === OPT_IN).map((skip) => skip.route));
  for (const entry of planned) {
    if (!entry.narrowing) continue;
    const why = unscopable(entry.narrowing, config);
    const missed = why ? [] : entry.narrowing.routes.filter((name) => !optIn.has(name) && !gatedNames.has(name));
    if (why || missed.length) {
      throw new Error(`internal: the gate scope (${gates.gateRoutes.join(', ')}) does not cover mutant `
        + `${entry.mutant.id} (${why ?? `it runs ${missed.join(', ')}`})`);
    }
  }
}
