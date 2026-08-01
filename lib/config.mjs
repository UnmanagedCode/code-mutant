// Loads `harness/mutation/config.json` -- the project-local layer, which is data
// rather than code so a read-only reviewer can audit it before believing the
// verdicts it produces.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR_REL = path.join('harness', 'mutation');
export const CONFIG_FILE_REL = path.join(CONFIG_DIR_REL, 'config.json');

export const DEFAULTS = {
  isolation: 'in-place',
  preserve: [],
  timeoutMs: 120_000,
  jobs: 1,
  setup: null,
  teardown: null,
};

export class ConfigError extends Error {}

function requireString(raw, field, configPath) {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${configPath}: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(raw, field, configPath) {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ConfigError(`${configPath}: "${field}" must be a string if present`);
  return value.trim() === '' ? null : value.trim();
}

export function configPathFor(repoRoot) {
  return path.join(repoRoot, CONFIG_FILE_REL);
}

// `warn` is injected so config loading stays testable without capturing stdio.
export function loadConfig({ repoRoot, overrides = {}, warn = () => {} }) {
  const configPath = configPathFor(repoRoot);
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `no mutation harness found at ${CONFIG_FILE_REL}.\n`
      + 'A harness is committed project state and building one is an implementer task -- see '
      + "code-mutant's scaffold/harness.md. Report the gap upward rather than proceeding: without a "
      + 'harness there is nothing to gate on, and a clean sweep would be a false claim.',
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${configPath}: not valid JSON (${err.message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${configPath}: expected a JSON object`);
  }

  const baselineCommand = requireString(raw, 'baselineCommand', configPath);
  const testCommand = requireString(raw, 'testCommand', configPath);
  const runner = requireString(raw, 'runner', configPath);

  let isolation = raw.isolation ?? DEFAULTS.isolation;
  if (isolation !== 'in-place' && isolation !== 'copy') {
    throw new ConfigError(`${configPath}: "isolation" must be "in-place" or "copy" (got ${JSON.stringify(raw.isolation)})`);
  }
  if (overrides.isolation) isolation = overrides.isolation;

  const preserve = raw.preserve ?? DEFAULTS.preserve;
  if (!Array.isArray(preserve) || preserve.some((p) => typeof p !== 'string')) {
    throw new ConfigError(`${configPath}: "preserve" must be an array of path strings`);
  }

  const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`${configPath}: "timeoutMs" must be a positive number`);
  }

  let jobs = overrides.jobs ?? raw.jobs ?? DEFAULTS.jobs;
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new ConfigError(`${configPath}: "jobs" must be a positive integer`);
  }
  // Concurrent in-place mutation is unsafe: two mutants would be applied to the
  // same tree at once and each would restore over the other. Clamped rather than
  // refused -- a logged degradation, so `--in-place` stays usable on a project
  // whose config sets jobs for its normal copy-mode runs.
  if (isolation === 'in-place' && jobs > 1) {
    warn(`jobs=${jobs} is not available in in-place mode (concurrent mutation of one tree is unsafe); using jobs=1`);
    jobs = 1;
  }

  return {
    repoRoot,
    configPath,
    configDir: path.dirname(configPath),
    baselineCommand,
    testCommand,
    runner,
    isolation,
    preserve,
    timeoutMs,
    jobs,
    setup: optionalString(raw, 'setup', configPath),
    teardown: optionalString(raw, 'teardown', configPath),
  };
}
