// Adapter registry, and the loader for the one sanctioned piece of project code.
//
// `runner: "custom"` loads `parse.mjs` from beside `config.json` (i.e.
// `harness/mutation/parse.mjs`). A project parser owns output parsing and nothing
// else -- never isolation, restore, or verdict semantics, which must mean the same
// thing in every project or the trust gates degrade into per-project code that
// validates itself.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as dotnet from './dotnet.mjs';
import * as exitCode from './exit-code.mjs';
import * as nodeTest from './node-test.mjs';
import * as pytest from './pytest.mjs';
import * as vitest from './vitest.mjs';

export const SHIPPED_ADAPTERS = {
  'node-test': nodeTest,
  pytest,
  vitest,
  dotnet,
  'exit-code': exitCode,
};

export const CUSTOM_PARSE_FILENAME = 'parse.mjs';

export class AdapterError extends Error {}

function validateParsed(result, source) {
  if (!result || typeof result !== 'object') {
    throw new AdapterError(`${source} returned ${result === undefined ? 'undefined' : typeof result}, expected an object`);
  }
  const gradeValue = result.grade ?? 'counted';
  if (gradeValue !== 'counted' && gradeValue !== 'exit-code') {
    throw new AdapterError(`${source} returned grade ${JSON.stringify(gradeValue)}; expected "counted" or "exit-code"`);
  }
  return result;
}

// The one canary prerequisite a counted-grade adapter cannot be missing: with no
// canary() there is no target in any repo state that could ever fire, so the gate
// is UNESTABLISHABLE rather than merely not established here. Reported pre-flight
// (lib/validate.mjs) and refused before the baseline is paid (lib/runner.mjs).
//
// testFilePatterns is deliberately NOT checked. Measured: a counted adapter with
// none still establishes the gate under `run` (the mutants' narrow scopes seed
// preferredFiles) and under `baseline` once a run has journalled a target -- so
// refusing it would refuse a harness that demonstrably works.
export function missingCanaryExports(adapter) {
  if (adapter.grade !== 'counted') return [];
  return adapter.canary ? [] : ['canary(source, { file })'];
}

// Wraps a custom module in the same surface a shipped adapter exposes, so the
// rest of the runner never branches on where the parser came from. Anything the
// project module does not provide falls back to a safe default rather than being
// invented: no name filtering, file-based scopes, and no canary -- absent rather
// than a stub, so `missingCanaryExports` above can see it is missing.
function wrapCustom(module, modulePath) {
  if (typeof module.parse !== 'function') {
    throw new AdapterError(
      `${modulePath} must export a function named "parse(stdout, stderr, exitCode)"`,
    );
  }
  return {
    name: 'custom',
    modulePath,
    grade: module.grade === 'exit-code' ? 'exit-code' : 'counted',
    canNameFilter: module.canNameFilter === true,
    // A parser that did not override scopeOf inherits node-test's file-part
    // derivation below, so its references ARE file-based. One that overrode it
    // has to say so, rather than have a path assumed of it.
    refsNameFiles: module.refsNameFiles ?? (typeof module.scopeOf !== 'function'),
    testFilePatterns: Array.isArray(module.testFilePatterns) ? module.testFilePatterns : [],
    parse: (stdout, stderr, exitCode_) => validateParsed(
      module.parse(stdout, stderr, exitCode_),
      `${modulePath} parse()`,
    ),
    scopeOf: typeof module.scopeOf === 'function' ? module.scopeOf : nodeTest.scopeOf,
    substitute: typeof module.substitute === 'function' ? module.substitute : nodeTest.substitute,
    canary: typeof module.canary === 'function' ? module.canary : null,
  };
}

export async function loadAdapter(runner, { configDir }) {
  if (runner === 'custom') {
    const modulePath = path.join(configDir, CUSTOM_PARSE_FILENAME);
    if (!existsSync(modulePath)) {
      throw new AdapterError(
        `runner is "custom" but ${modulePath} does not exist. `
        + 'A custom parser lives beside config.json and exports parse(stdout, stderr, exitCode).',
      );
    }
    const module = await import(pathToFileURL(modulePath).href);
    return wrapCustom(module, modulePath);
  }

  const adapter = SHIPPED_ADAPTERS[runner];
  if (!adapter) {
    throw new AdapterError(
      `unknown runner ${JSON.stringify(runner)}. Shipped adapters: `
      + `${Object.keys(SHIPPED_ADAPTERS).join(', ')}, or "custom" for a project-local parse.mjs.`,
    );
  }
  return {
    name: adapter.name,
    modulePath: null,
    grade: adapter.grade,
    canNameFilter: adapter.canNameFilter,
    refsNameFiles: adapter.refsNameFiles,
    testFilePatterns: adapter.testFilePatterns,
    parse: (stdout, stderr, exitCode_) => validateParsed(
      adapter.parse(stdout, stderr, exitCode_),
      `${adapter.name} parse()`,
    ),
    scopeOf: adapter.scopeOf,
    substitute: adapter.substitute,
    canary: adapter.canary,
  };
}
