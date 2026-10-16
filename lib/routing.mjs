// Routing: one harness, several runners, each owning the test FILES its `tests`
// globs match (config.json `routes`, validated in lib/config.mjs).
//
// It lands as a COMPOSITE ADAPTER whose commands are single strings -- each one
// an invocation of the route driver (lib/route-exec.mjs) -- so the runner never
// branches on it: restore, the journal, the gate cache, the worker pool and
// Phase A/B all see one adapter and one command, exactly as for a single runner.
// What changes is inside `parse`, which hands each route's output to that
// route's own adapter and reports the per-route results as `groups`, and in the
// few places that must judge every group on its own (lib/measure.mjs isGreen,
// lib/classify.mjs) rather than trust the merged counters.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdapterError, loadAdapter } from './adapters/index.mjs';
import { countedResult, shellQuote, splitRef } from './adapters/common.mjs';
import { globToRegExp } from './glob.mjs';
import { describeNotGreen, isGreen } from './measure.mjs';
import { PLACEHOLDER, substituteInto } from './narrow.mjs';
import { ENVELOPE_MARKER } from './route-exec.mjs';

export const ROUTE_EXEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'route-exec.mjs');

// `pairs` is [[routeName, command], ...]. The driver is run by THIS node, by
// absolute path, so the command needs nothing on PATH and no install.
export function compileRoutedCommand(pairs) {
  return [
    shellQuote(process.execPath),
    shellQuote(ROUTE_EXEC_PATH),
    ...pairs.flatMap(([name, command]) => [shellQuote(name), shellQuote(command)]),
  ].join(' ');
}

// Why a route's runner cannot be routed, or null. Routing splits test FILES, so
// it needs an adapter whose references name files and whose output names failed
// tests: exit-code grade has no named test to route, and dotnet (or a custom
// parser with its own scopeOf) has refs that are not files.
function unroutable(adapter) {
  if (adapter.grade === 'exit-code') {
    return 'it is exit-code grade -- routing splits test FILES, and a gate with no named tests has no file to route';
  }
  if (adapter.grade !== 'counted') return `its grade ${JSON.stringify(adapter.grade)} is not counted`;
  if (adapter.refsNameFiles !== true) {
    return 'its test references do not name files (dotnet, or a custom parser with its own scopeOf), so no file '
      + 'can be routed to it';
  }
  return null;
}

function describePatterns(routes) {
  return routes.map((route) => `${route.name}: ${route.tests.join(', ')}`).join('; ');
}

export function createRoutedAdapter(routes) {
  const routeOf = (file) => routes.find((route) => route.regexes.some((re) => re.test(file))) ?? null;
  const routeOfOrThrow = (file) => {
    const route = routeOf(file);
    if (!route) throw new Error(`${file} matches no route's tests (${describePatterns(routes)})`);
    return route;
  };
  const scopeOf = (ref) => splitRef(ref).file;

  return {
    name: 'routed',
    grade: 'counted',
    modulePath: null,
    routes,
    routeOf,
    refsNameFiles: true,
    canNameFilter: routes.every((route) => route.adapter.canNameFilter === true),
    testFilePatterns: [...new Set(routes.flatMap((route) => route.tests))],
    readsReportDir: false,
    requiredFlags: null,
    scopeOf,

    // Route names, in declared order, that own at least one of `scopes`.
    routesOf(scopes) {
      const owned = new Set(scopes.map((file) => routeOfOrThrow(file).name));
      return routes.filter((route) => owned.has(route.name)).map((route) => route.name);
    },

    // A route with no ref in scope is not run at all: it would judge nothing.
    substitute({ scopes, refs, mode }) {
      const pairs = [];
      for (const scope of scopes) routeOfOrThrow(scope);
      for (const route of routes) {
        const routeScopes = scopes.filter((file) => routeOf(file) === route);
        if (!routeScopes.length) continue;
        const routeRefs = refs.filter((ref) => routeOf(scopeOf(ref)) === route);
        const { command } = substituteInto(
          route.testCommand,
          route.adapter.substitute({ scopes: routeScopes, refs: routeRefs, mode }),
        );
        pairs.push([route.name, command]);
      }
      return compileRoutedCommand(pairs);
    },

    // The canary is the owning route's own. An unrouted file is declined, as an
    // adapter declines a file it cannot synthesise into.
    canary(source, { file }) {
      const route = routeOf(file);
      if (!route || typeof route.adapter.canary !== 'function') return null;
      return route.adapter.canary(source, { file });
    },

    parse(stdout, stderr, exitCode, context = {}) {
      const line = String(stdout ?? '').split('\n').find((text) => text.startsWith(`${ENVELOPE_MARKER} `));
      let envelope = null;
      try {
        envelope = line ? JSON.parse(line.slice(ENVELOPE_MARKER.length + 1)) : null;
      } catch {
        envelope = null;
      }
      if (!envelope || !Array.isArray(envelope.groups)) {
        const tail = String(stderr ?? '').trim().split('\n').slice(-5).join(' | ');
        return {
          ...countedResult({ counts: { exitCode } }),
          groups: [],
          diagnostic: `route driver produced no envelope${tail ? ` (stderr: ${tail})` : ''}`,
        };
      }

      const groups = envelope.groups.map((group) => {
        const route = routes.find((r) => r.name === group.route);
        if (!route) throw new AdapterError(`route driver reported an unknown route ${JSON.stringify(group.route)}`);
        const sub = route.adapter.parse(group.stdout, group.stderr, group.exitCode, {
          cwd: context.cwd, reports: group.reports ?? {},
        });
        const run = {
          exitCode: group.exitCode,
          timedOut: false,
          truncated: group.truncated === true,
          outputIncomplete: group.outputIncomplete === true,
          spawnError: group.spawnError ?? null,
          durationMs: group.durationMs,
        };
        const green = isGreen({ run, parsed: sub });
        return {
          route: route.name,
          runner: route.runner,
          exitCode: group.exitCode,
          durationMs: group.durationMs,
          run,
          parsed: sub,
          green,
          detail: green ? null : describeNotGreen({ run, parsed: sub }),
        };
      });

      const sum = (field) => groups.reduce((total, group) => total + (group.parsed[field] ?? 0), 0);
      return {
        ...countedResult({
          passed: sum('passed'),
          failed: sum('failed'),
          skipped: sum('skipped'),
          ran: sum('ran'),
          // Ids are file-qualified, so they cannot collide across routes.
          failedTests: groups.flatMap((group) => group.parsed.failedTests),
          compileError: groups.some((group) => group.parsed.compileError),
          counts: { exitCode },
        }),
        groups,
        diagnostic: null,
      };
    },
  };
}

// The per-route summary a report record carries, without the parsed payloads.
// `judged: false` for a mutant run, where a route going red is the point and a
// baseline's green/not-green reading would mislabel it.
export function summarizeGroups(groups, { judged = true } = {}) {
  return groups.map((group) => ({
    route: group.route,
    runner: group.runner,
    counts: {
      passed: group.parsed.passed, failed: group.parsed.failed, skipped: group.parsed.skipped, ran: group.parsed.ran,
    },
    exitCode: group.exitCode,
    ...(judged ? { green: group.green, detail: group.detail } : {}),
    durationMs: group.durationMs,
  }));
}

// The config and adapter a command runs against. A single-runner config loads
// its adapter exactly as it always has. A routed one loads every route's
// adapter, refuses any that cannot be routed, and composes them.
export async function loadHarness(config) {
  if (!config.routes) {
    return { config, adapter: await loadAdapter(config.runner, { configDir: config.configDir }) };
  }
  const routes = [];
  for (const route of config.routes) {
    let adapter;
    try {
      adapter = await loadAdapter(route.runner, { configDir: config.configDir });
    } catch (err) {
      if (err instanceof AdapterError) throw new AdapterError(`route ${JSON.stringify(route.name)}: ${err.message}`);
      throw err;
    }
    const why = unroutable(adapter);
    if (why) throw new AdapterError(`route ${JSON.stringify(route.name)}: runner ${JSON.stringify(route.runner)} cannot be routed: ${why}`);
    routes.push({ ...route, regexes: route.tests.map(globToRegExp), adapter });
  }
  const adapter = createRoutedAdapter(routes);
  return {
    config: {
      ...config,
      baselineCommand: compileRoutedCommand(routes.map((route) => [route.name, route.baselineCommand])),
      // The composite IS the substitution: planNarrowing puts the routed
      // adapter's whole driver command in place of {tests}, so the narrowed
      // command is exactly that string and `placeholder` is true.
      testCommand: PLACEHOLDER,
    },
    adapter,
  };
}
