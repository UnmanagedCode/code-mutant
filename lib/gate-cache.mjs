// The baseline+canary gate cache: derive the key, read an entry, write an entry.
//
// `timings.gatesMs` was a FIXED cost paid once per invocation, independent of
// mutant count: two full `baselineCommand` runs. Measured on code-conductor
// (`npm test` ~67s), BEFORE the canary was narrowed: ~135,000ms, 98.6% of a
// single-mutant invocation, against ~1,000ms of narrow baselines. A prover
// invoking the runner once per mutant spent ~63 minutes on a catalog that costs
// ~3 minutes in one invocation.
//
// WHAT THIS MODULE CACHES IS THE BASELINE HALF, AND -- when the canary ran at
// baseline scope -- the canary too. A narrow-scope canary is derived from the
// mutant catalog, which the key deliberately does not cover, so lib/runner.mjs
// files `canary: null` for it and re-establishes it every invocation; `baseline
// --no-canary` measures no canary and files `canary: null` too. That is why a
// present-but-null canary is a LEGAL entry below rather than a rejected one.
// A later hit may FILL a null slot, once, with a baseline-scope KILLED canary it
// measured fresh -- never overwrite a stored one (lib/runner.mjs, canaryToFill).
// Nothing about the baseline depends on which mutants are in the run.
//
// ONE RESPONSIBILITY, the same contract lib/journal.mjs states: this module
// decides nothing about what may be REUSED -- lib/runner.mjs owns that. It only
// answers "what identifies this measurement" and "where does it live".
//
// EVERY DESIGN CHOICE HERE IS BIASED TOWARD A FALSE MISS. A false miss costs one
// re-measure; a false hit reports a green baseline against a tree that changed,
// which is the exact class of fast wrong answer this whole harness exists to
// prevent. So the key is over worktree BYTES rather than a commit sha, the
// harness's own source is digested rather than trusting a version string, and a
// malformed entry re-measures rather than being repaired.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MUTATION_DIR, mutationDir } from './catalog.mjs';
import { canonical, sha256 } from './fingerprint.mjs';
import { gitCapture } from './git.mjs';

export const GATES_DIR = 'gates';
export const GATES_DIR_REL = path.posix.join(MUTATION_DIR, GATES_DIR);
// 2: the entry shape gained a nullable `gates.canary` (a narrow-scope canary is
// never cached). `harnessFingerprint` would invalidate every existing entry
// anyway, but it identifies the HARNESS where this identifies the entry SHAPE --
// conflating the two is how one of them silently stops being maintained.
// 3: the entry gained `canaryMeasuredAt`, which differs from `measuredAt` once a
// later hit has filled an empty canary slot.
export const GATE_CACHE_SCHEMA_VERSION = 3;

export function gatesDir(repoRoot) {
  return path.join(mutationDir(repoRoot), GATES_DIR);
}

export function gateCachePath(repoRoot, key) {
  return path.join(gatesDir(repoRoot), `${key}.json`);
}

// Every path `git status --porcelain -z -uall` names, rename/copy sources
// included. `-z` because a path may contain a newline, and the non-`-z` format
// quotes such paths instead of emitting them raw -- a quoted path would not
// resolve and would silently hash as `absent`.
function changedPaths(porcelainZ) {
  const fields = porcelainZ.split('\0');
  const paths = new Set();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const xy = field.slice(0, 2);
    paths.add(field.slice(3));
    // `R`/`C` entries carry their source path as the NEXT NUL-separated field.
    if (/[RC]/.test(xy)) {
      i += 1;
      if (fields[i]) paths.add(fields[i]);
    }
  }
  return [...paths].sort();
}

// `null` means "this path cannot be reduced to bytes" -- never a shared constant.
// A constant here was a FALSE-HIT HOLE: every directory git names collapsed to
// one string, so two trees differing only inside such a path hashed the same.
// Two real shapes land here and both vary freely underneath:
//
//   - an untracked EMBEDDED git repo, which `-uall` collapses to a single
//     `?? vendor/inner/` entry (a plain untracked directory is expanded to its
//     files and is not affected);
//   - a submodule with dirty contents, which is always the single line ` M sub`
//     however much of its worktree changed.
//
// The caller turns a `null` into a forced miss for the whole tree.
function pathState(repoRoot, rel) {
  const abs = path.join(repoRoot, rel);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    // Deleted, staged-deleted, or a rename source: absence is a state, and one
    // that must differ from every content hash.
    return 'absent';
  }
  if (stat.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
  if (!stat.isFile()) return null;
  // `mode` alongside the content hash: `chmod +x` with identical bytes is
  // reported by porcelain, and a suite that shells out to the file gets a
  // different answer for it. (Under `core.fileMode=false` git reports nothing at
  // all, which rides on the same stat-cache trust the module header discloses.)
  try {
    return `${stat.mode}:${sha256(readFileSync(abs))}`;
  } catch {
    // Unreadable is not "empty" and not "absent": it is unknown, so it fails
    // closed like every other state this function cannot determine.
    return null;
  }
}

// WHAT MAKES A HIT MEAN "byte-identical tree" RATHER THAN "same commit".
//
// Committed content rides `HEAD^{tree}` for free; everything git reports as
// modified, staged, deleted or untracked-and-not-ignored is content-hashed on
// top. So an amend or a rebase that changes no bytes does not force a
// re-measure, and an uncommitted edit cannot be served a measurement made
// before it.
//
// This trusts `git status --porcelain` to name every path whose worktree bytes
// differ from HEAD. That is not a new trust boundary: lib/workspace.mjs rests
// the whole in-place no-trace proof on exactly this comparison, so adopting it
// here keeps ONE answer to "did this tree change" rather than a second
// implementation that could disagree with the first.
// Returns `{ digest, reason }`. A NULL DIGEST is the fail-closed answer: this
// tree cannot be keyed, so the caller must measure both gates and write nothing.
// `reason` says which of the two causes it was, for the report and the log.
//
// A forced miss costs one re-measure. It is also nearly free in practice, because
// every shape that produces one -- an unborn HEAD, an embedded untracked repo, a
// dirty submodule, an unreadable path -- is a tree `run` and `baseline` already
// refuse as dirty or unusable. What stays cacheable is the clean tree, which is
// the case this whole feature was opened on.
export function treeDigest(repoRoot) {
  let tree;
  try {
    tree = gitCapture(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  } catch {
    // An unborn branch has no committed state to key on. A miss, never a throw:
    // the gates ran fine on such a repo before this module existed and must
    // still, so this cannot become a new refusal.
    return { digest: null, reason: 'HEAD does not resolve to a tree (an unborn branch has no committed state to key on)' };
  }
  const porcelain = gitCapture(repoRoot, ['status', '--porcelain', '-z', '-uall']);
  const worktree = [];
  for (const rel of changedPaths(porcelain)) {
    const state = pathState(repoRoot, rel);
    if (state === null) {
      return {
        digest: null,
        reason: `${rel} is named by git status but cannot be reduced to bytes (an embedded repository, `
          + 'a submodule, or an unreadable path), so no key over this tree could tell its contents apart',
      };
    }
    worktree.push([rel, state]);
  }
  return { digest: sha256(canonical({ tree, worktree })), reason: null };
}

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function harnessSources(root) {
  const files = ['mutate.mjs'];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.mjs')) files.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'lib'));
  return files.sort();
}

let memoised = null;

// THE HARNESS VERSION, self-maintaining. package.json carries no `version`
// field and this is a private plugin merged with no release step, so a version
// string only invalidates when someone remembers to bump it -- and a merged fix
// is not even live until the orchestrator restarts. A digest over the source
// cannot drift from the code it identifies.
//
// `root` is injectable only so a test can fingerprint a copied tree; nothing in
// the shipped path passes it. ~29 files, ~5ms, memoised per process.
export function harnessFingerprint({ root = HARNESS_ROOT } = {}) {
  if (root === HARNESS_ROOT && memoised) return memoised;
  const digest = sha256(canonical(
    harnessSources(root).map((rel) => [rel, sha256(readFileSync(path.join(root, rel)))]),
  ));
  if (root === HARNESS_ROOT) memoised = digest;
  return digest;
}

export function runtimeFingerprint() {
  // A node upgrade changes what a suite does without changing a byte of the
  // tree, and a bind-mounted worktree can be entered from two platforms.
  return { version: process.version, platform: process.platform, arch: process.arch };
}

// Truncated to 32 hex, the same shape journalKey uses -- a filename a human can
// read back off a report and match by eye.
//
// `jobs` is deliberately ABSENT, the one contrast with journalKey: the gates run
// serially in the primary workspace during Phase A, before any concurrency
// exists, so a gate measured serially is the same measurement at any `jobs`.
// Reusing a jobs=4 VERDICT under jobs=1 would hide the concurrent-suite hazard;
// reusing a gate measurement cannot. `learn` is absent for the same class of
// reason: it suppresses grading and changes neither gate command.
export function gateCacheKey({
  treeDigest: tree, configFingerprint, adapter, isolation, harnessFingerprint: harness, runtime,
}) {
  return sha256(canonical({
    treeDigest: tree,
    configFingerprint,
    adapter: { name: adapter.name, grade: adapter.grade, modulePath: adapter.modulePath ?? null },
    isolation,
    harnessFingerprint: harness,
    runtime,
  })).slice(0, 32);
}

// A malformed entry is a LOGGED MISS, never a throw and never a repair: the
// cache is an optimisation, and a run that cannot read one must still be able to
// measure. The filename is the key -- `keyInputs` inside the entry is recorded
// so an operator can diff two entries and see why one missed, and is never read
// back as an authority.
export function readGateEntry(repoRoot, key, log = () => {}) {
  const file = gateCachePath(repoRoot, key);
  if (!existsSync(file)) return null;
  const reject = (why) => {
    log(`gate cache: ignoring ${file} (${why}); re-measuring`);
    return null;
  };
  let entry;
  try {
    // The read is inside the try as well as the parse: an unreadable entry
    // (EACCES on a chmod 000 file) is exactly as much a miss as an unparseable
    // one, and a crafted entry must never be able to deny the run.
    entry = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return reject(`unreadable or not valid JSON: ${err.message}`);
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return reject('not a JSON object');
  if (entry.schemaVersion !== GATE_CACHE_SCHEMA_VERSION) {
    return reject(`schemaVersion ${JSON.stringify(entry.schemaVersion)}, expected ${GATE_CACHE_SCHEMA_VERSION}`);
  }
  if (entry.key !== key) return reject(`records key ${JSON.stringify(entry.key)}, not the key it is filed under`);
  // `canary` must be PRESENT and may be null (a narrow-scope canary, not cached).
  // An absent key is still a malformed entry: a reader could not tell it from an
  // entry written before the field existed.
  const gates = entry.gates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) return reject('missing a gate record');
  if (!gates.baseline || !('canary' in gates)) return reject('missing a gate record');
  if (!('canaryMeasuredAt' in entry)) return reject('missing canaryMeasuredAt');
  return entry;
}

// Atomic: a SIGKILL mid-write must leave no half-entry for a later run to parse
// as a gate result. Same directory for the temp file, so the rename is a rename
// and not a cross-device copy.
export function writeGateEntry(repoRoot, key, entry) {
  const file = gateCachePath(repoRoot, key);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}
