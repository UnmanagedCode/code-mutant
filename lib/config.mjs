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
  // The adaptive hang deadline. `timeoutMs` alone is a single ceiling for every
  // command, so a hung mutant costs the whole ceiling even though the SAME SCOPE,
  // UNMUTATED, was just measured and its duration is known. `factor` multiplies
  // that reference; `floorMs` keeps a fast scope from getting a deadline so tight
  // that ordinary variance reads as a hang.
  hang: { factor: 10, floorMs: 10_000 },
};

export class ConfigError extends Error {}

// A project with no harness is in a SUPPORTED state, not a broken one -- the owner
// decides mutation-testing opt-in at project creation. mutate.mjs checks this
// subclass first, so the notice lands on stdout with its own exit code instead of
// being caught as a ConfigError and printed to stderr as an error.
export class NoHarnessError extends ConfigError {}

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

// `floorMs: 0` is explicitly permitted (factor-only, no floor). Without it the
// deadline's UPPER behaviour is untestable in a fast fixture -- every reference
// would land on the floor -- and a knob whose effect cannot be observed is a knob
// nobody can tune. `factor: 0` disables the adaptive path entirely, restoring the
// single `timeoutMs` ceiling.
function requireHang(raw, configPath) {
  const value = raw.hang ?? {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${configPath}: "hang" must be an object with optional "factor" and "floorMs"`);
  }
  const factor = value.factor ?? DEFAULTS.hang.factor;
  if (!Number.isFinite(factor) || factor < 0) {
    throw new ConfigError(
      `${configPath}: "hang.factor" must be a non-negative number (0 disables the adaptive deadline)`,
    );
  }
  const floorMs = value.floorMs ?? DEFAULTS.hang.floorMs;
  if (!Number.isInteger(floorMs) || floorMs < 0) {
    throw new ConfigError(`${configPath}: "hang.floorMs" must be a non-negative integer (0 means no floor)`);
  }
  return { factor, floorMs };
}

export function configPathFor(repoRoot) {
  return path.join(repoRoot, CONFIG_FILE_REL);
}

// `warn` is injected so config loading stays testable without capturing stdio.
export function loadConfig({ repoRoot, overrides = {}, warn = () => {} }) {
  const configPath = configPathFor(repoRoot);
  if (!existsSync(configPath)) {
    throw new NoHarnessError(
      `${CONFIG_FILE_REL} is absent, so this project is not configured for mutation testing.\n`
      + 'That is a supported state, decided at project creation -- not a gap, and nothing to '
      + 'escalate or wait on. Nothing ran and nothing is claimed: note the absence and finish the '
      + 'review without mutation proof. Do not mutate by hand and do not build a harness here; '
      + "opting this project in is separate, owner-directed work against code-mutant's "
      + 'scaffold/harness.md.',
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
  // Copy mode CAN run concurrently -- each worker owns one copy exclusively, and
  // lib/occupancy.mjs asserts it. What concurrency cannot make safe is the
  // project's own suite, so the residual hazard is named rather than hinted at:
  // the reader has to be able to check their suite against a list.
  if (isolation === 'copy' && jobs > 1) {
    warn(
      `jobs=${jobs} runs your test suite ${jobs} times CONCURRENTLY, in ${jobs} copies of the tree. `
      + 'That is unsafe if the suite binds a fixed TCP port, writes a fixed temp or data directory, '
      + 'shares a database or an on-disk fixture it mutates in place, writes a shared build/package '
      + 'cache, or depends on the checkout\'s absolute path. Note also that "preserve" entries are '
      + 'SYMLINKED into every copy, so a preserved path is shared writable state across all workers '
      + 'and the real tree. Use jobs=1 if any of that applies.',
    );
  }

  // Used only by `run`'s empty-diff-vs-base gate; `--base` overrides it per
  // invocation the same way `--copy`/`--in-place` override `isolation`.
  const baseBranch = overrides.baseBranch ?? optionalString(raw, 'baseBranch', configPath);

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
    hang: requireHang(raw, configPath),
    jobs,
    baseBranch,
    setup: optionalString(raw, 'setup', configPath),
    teardown: optionalString(raw, 'teardown', configPath),
  };
}
