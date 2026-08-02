// The per-review mutant catalog at `.mutation/mutants.json`, and the results
// directory beside it.
//
// Both are gitignored and die with the worktree. That is what eliminates the
// read-only collision rather than merely managing it: gitignored writes never
// appear in `git status --porcelain`, so the reviewer has nothing to stage,
// nothing to commit, and hands the implementer no catalog -- only findings.
//
// The format is specified in mutants.schema.md, which is its single home. This
// module validates against that spec; it does not redefine it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MUTATION_DIR = '.mutation';
export const CATALOG_FILE = 'mutants.json';
export const RESULTS_DIR = 'results';

export class CatalogError extends Error {}

export function mutationDir(repoRoot) {
  return path.join(repoRoot, MUTATION_DIR);
}

export function catalogPath(repoRoot) {
  return path.join(mutationDir(repoRoot), CATALOG_FILE);
}

// The "reviewer leaves no trace" property rests entirely on `.mutation/` being
// gitignored, but that .gitignore line is the SCAFFOLD's job -- so a project that
// was never scaffolded, or scaffolded badly, would have the reviewer dropping
// visible untracked files into a worktree it shares with the implementer.
//
// This is a HARD STOP rather than a warning, deliberately. A warning lets the
// first person who ignores it pollute a shared tree, and the reviewer that did it
// cannot clean up after itself: it is read-only and does not own the commit that
// would fix .gitignore. A stop costs an implementer one line; a polluted shared
// worktree discovered mid-review does not unwind cleanly.
//
// Probes a path INSIDE the directory, not the directory itself: the conventional
// `.mutation/` pattern is directory-only, so `git check-ignore .mutation` reports
// "not ignored" whenever the directory does not exist yet -- which is the normal
// state on round 1 and would make this guard fire on correctly configured projects.
export function assertMutationDirIgnored(repoRoot) {
  const probe = path.posix.join(MUTATION_DIR, RESULTS_DIR, 'probe.json');
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', probe], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
    });
    ignored = true;
  } catch {
    ignored = false;
  }

  if (!ignored) {
    throw new CatalogError(
      `${MUTATION_DIR}/ is NOT gitignored in ${repoRoot}, so writing there would leave visible `
      + 'untracked files in a worktree this run does not own.\n'
      + `Refusing to write. Add "${MUTATION_DIR}/" to the project's .gitignore -- that is part of the `
      + "mutation harness bootstrap (see code-mutant's scaffold/harness.md) and is an implementer task.",
    );
  }
}

const REQUIRED_STRING_FIELDS = ['id', 'invariant', 'whyNotEquivalent'];

export function validateMutant(mutant, where) {
  if (!mutant || typeof mutant !== 'object' || Array.isArray(mutant)) {
    throw new CatalogError(`${where}: each mutant must be a JSON object`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof mutant[field] !== 'string' || mutant[field].trim() === '') {
      throw new CatalogError(
        `${where}: "${field}" is required and must be a non-empty string`
        + (field === 'whyNotEquivalent'
          ? ' -- it forces the author to state why the change is genuinely behaviour-changing, '
            + 'which is the one thing the runner cannot decide'
          : ''),
      );
    }
  }
  if (/^line \d+$/i.test(mutant.invariant.trim())) {
    throw new CatalogError(`${where}: "invariant" must name the invariant in prose, not a line number`);
  }
  if (!Array.isArray(mutant.sites) || mutant.sites.length === 0) {
    throw new CatalogError(`${where}: "sites" must be a non-empty array (an array, so a double-guarded invariant can be mutated at several places at once)`);
  }
  for (const field of ['expectFail', 'expectPass']) {
    const value = mutant[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new CatalogError(`${where}: "${field}" must be an array of test-reference strings`);
    }
  }
  if (mutant.narrowTo !== undefined && mutant.narrowTo !== 'file' && mutant.narrowTo !== 'names') {
    throw new CatalogError(`${where}: "narrowTo" must be "file" (the default) or "names"`);
  }
  if (mutant.waived !== undefined) {
    if (!mutant.waived || typeof mutant.waived !== 'object' || Array.isArray(mutant.waived)
      || typeof mutant.waived.reason !== 'string' || mutant.waived.reason.trim() === '') {
      throw new CatalogError(`${where}: "waived" must be an object with a non-empty "reason" recording the conductor's decision`);
    }
  }
  return {
    ...mutant,
    expectFail: mutant.expectFail ?? [],
    expectPass: mutant.expectPass ?? [],
    narrowTo: mutant.narrowTo ?? 'file',
  };
}

export function loadCatalog(repoRoot) {
  const file = catalogPath(repoRoot);
  if (!existsSync(file)) return { path: file, exists: false, mutants: [] };

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CatalogError(`${file}: not valid JSON (${err.message})`);
  }

  // Accept either a bare array or `{ mutants: [...] }`.
  const list = Array.isArray(raw) ? raw : raw?.mutants;
  if (!Array.isArray(list)) {
    throw new CatalogError(`${file}: expected an array of mutants, or an object with a "mutants" array`);
  }

  const mutants = list.map((mutant, index) => validateMutant(mutant, `${file} [${index}]`));
  const seen = new Set();
  for (const mutant of mutants) {
    if (seen.has(mutant.id)) throw new CatalogError(`${file}: duplicate mutant id ${JSON.stringify(mutant.id)}`);
    seen.add(mutant.id);
  }
  return { path: file, exists: true, mutants };
}

// For the commands that act ON catalog entries (`run`, `validate`, `probe --id`):
// an absent catalog is a refusal, because there is nothing to act on and guessing
// would be worse. `candidates` deliberately does NOT use this -- it takes the
// catalog as coverage context and an empty one is its normal round-1 state.
export function requireCatalog(repoRoot) {
  const catalog = loadCatalog(repoRoot);
  if (!catalog.exists) {
    throw new CatalogError(
      `no catalog at ${catalog.path}. The catalog is per-review and authored by the reviewer; `
      + 'see mutants.schema.md for the format.',
    );
  }
  return catalog;
}

// Selects by id in the order asked for, refusing unknown ids rather than running
// a subset of what was requested.
export function selectById(catalog, ids) {
  const byId = new Map(catalog.mutants.map((m) => [m.id, m]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new CatalogError(`no mutant with id ${missing.join(', ')} in ${catalog.path}`);
  return ids.map((id) => byId.get(id));
}

export function writeResults(repoRoot, runId, report) {
  assertMutationDirIgnored(repoRoot);
  const dir = path.join(mutationDir(repoRoot), RESULTS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
