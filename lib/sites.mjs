// Resolving a mutant's sites into a concrete, applicable edit -- and refusing
// anything ambiguous rather than guessing.
//
// A non-unique anchor producing a malformed edit is a failure observed in real
// by-hand sessions ("`.bar-label` occurs inside the media block too"), so an
// anchor that matches zero or more than once is an ERROR verdict, never a
// best-effort edit. A replacement identical to the anchor is refused too: a
// mutant that changes nothing would read SURVIVED and manufacture a false
// finding.
//
// The git calls here are READ-ONLY (`--numstat`, `--summary`, `--check`). They
// derive a patch's path set and validate it; they never apply or reverse
// anything. Restore does not use git at all -- see snapshot.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SiteErrorCode = {
  FILE_MISSING: 'file-missing',
  ANCHOR_MISSING: 'anchor-missing',
  ANCHOR_AMBIGUOUS: 'anchor-ambiguous',
  NO_OP: 'no-op',
  OVERLAPPING_ANCHORS: 'overlapping-anchors',
  MIXED_SITE_FORMS: 'mixed-site-forms',
  PATCH_UNPARSEABLE: 'patch-unparseable',
  PATCH_REJECTED: 'patch-rejected',
  INVALID_SITE: 'invalid-site',
};

export class SiteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function countOccurrences(haystack, needle) {
  const indices = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    indices.push(at);
    from = at + 1; // overlapping occurrences still count as ambiguity
  }
  return indices;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

// ---------------------------------------------------------------- patch paths
//
// Two independent derivations, because they disagree in a way that matters:
// `git apply --numstat` lists only the DESTINATION of a rename, omitting the
// source it deletes. Snapshotting from numstat alone would leave the
// renamed-away file unrecorded, and restore would not bring it back -- silent
// loss of a real file. So the snapshot path set is the UNION (over-snapshotting
// is harmless), and any disagreement is recorded in the report rather than
// swallowed, so a parser bug on some future patch shape surfaces instead of
// hiding behind the union.

function unquoteGitPath(raw) {
  if (!raw.startsWith('"')) return raw;
  try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
}

function stripPrefix(raw, prefix) {
  const value = unquoteGitPath(raw.split('\t')[0].trim());
  if (value === '/dev/null') return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// Hand-parse of the unified diff: the `---`/`+++` header pair plus explicit
// rename lines. Catches both sides of every change, including the rename source.
export function parsePatchPaths(patchText) {
  const paths = new Set();
  const renames = [];
  let pendingRenameFrom = null;

  for (const line of patchText.split('\n')) {
    if (line.startsWith('--- ')) {
      const value = stripPrefix(line.slice(4), 'a/');
      if (value) paths.add(value);
    } else if (line.startsWith('+++ ')) {
      const value = stripPrefix(line.slice(4), 'b/');
      if (value) paths.add(value);
    } else if (line.startsWith('rename from ')) {
      pendingRenameFrom = unquoteGitPath(line.slice('rename from '.length).trim());
      paths.add(pendingRenameFrom);
    } else if (line.startsWith('rename to ')) {
      const to = unquoteGitPath(line.slice('rename to '.length).trim());
      paths.add(to);
      renames.push({ from: pendingRenameFrom, to });
      pendingRenameFrom = null;
    }
  }

  return { paths: [...paths], renames };
}

function gitApplyRead(root, patchText, flags) {
  try {
    const stdout = execFileSync('git', ['apply', ...flags, '-'], {
      cwd: root,
      input: patchText,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? (err.message ?? String(err)),
    };
  }
}

// numstat lines are `<added>\t<deleted>\t<path>`; a rename may render the path
// field as `old => new` or `dir/{old => new}`.
function parseNumstat(stdout) {
  const paths = new Set();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const raw = unquoteGitPath(fields.slice(2).join('\t').trim());
    const braced = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (braced) {
      paths.add(path.posix.normalize(`${braced[1]}${braced[2]}${braced[4]}`));
      paths.add(path.posix.normalize(`${braced[1]}${braced[3]}${braced[4]}`));
      continue;
    }
    const arrow = raw.split(' => ');
    if (arrow.length === 2) {
      paths.add(arrow[0].trim());
      paths.add(arrow[1].trim());
      continue;
    }
    paths.add(raw);
  }
  return [...paths];
}

function parseSummary(stdout) {
  const renames = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^rename (.+) => (.+?)(?: \(\d+%\))?$/);
    if (match) renames.push({ from: unquoteGitPath(match[1]), to: unquoteGitPath(match[2]) });
  }
  return { renames };
}

// Returns the union path set plus a full record of how the two derivations
// compared, so `--json` can carry the evidence.
export function patchPathSet(root, patchText) {
  const numstat = gitApplyRead(root, patchText, ['--numstat']);
  if (!numstat.ok) {
    throw new SiteError(
      SiteErrorCode.PATCH_UNPARSEABLE,
      `git could not read the patch: ${numstat.stderr.trim()}`,
    );
  }
  const summary = gitApplyRead(root, patchText, ['--summary']);

  const fromGit = parseNumstat(numstat.stdout);
  const parsed = parsePatchPaths(patchText);
  const fromParse = parsed.paths;
  const gitRenames = summary.ok ? parseSummary(summary.stdout).renames : [];
  const renames = gitRenames.length ? gitRenames : parsed.renames;

  const gitSet = new Set(fromGit);
  const parseSet = new Set(fromParse);
  const onlyFromGit = fromGit.filter((p) => !parseSet.has(p));
  const onlyFromParse = fromParse.filter((p) => !gitSet.has(p));
  const renameSources = new Set(renames.map((r) => r.from));

  return {
    paths: [...new Set([...fromGit, ...fromParse])].sort(),
    fromGit: fromGit.slice().sort(),
    fromParse: fromParse.slice().sort(),
    onlyFromGit: onlyFromGit.slice().sort(),
    onlyFromParse: onlyFromParse.slice().sort(),
    renames,
    agree: onlyFromGit.length === 0 && onlyFromParse.length === 0,
    // `git apply --numstat` always omits a rename's source, so that specific
    // disagreement is expected. Any other one is worth a reader's attention.
    mismatchExplainedByRename:
      onlyFromGit.length === 0 && onlyFromParse.length > 0
      && onlyFromParse.every((p) => renameSources.has(p)),
  };
}

// ---------------------------------------------------------------- resolution

function resolveAnchorGroup(root, file, sites) {
  const abs = path.resolve(root, file);
  if (!existsSync(abs)) {
    throw new SiteError(SiteErrorCode.FILE_MISSING, `${file} does not exist in the workspace`);
  }
  const original = readFileSync(abs, 'utf8');

  const matches = [];
  for (const site of sites) {
    if (typeof site.anchor !== 'string' || site.anchor.length === 0) {
      throw new SiteError(SiteErrorCode.INVALID_SITE, `${file}: site needs a non-empty "anchor"`);
    }
    if (typeof site.replacement !== 'string') {
      throw new SiteError(SiteErrorCode.INVALID_SITE, `${file}: site needs a "replacement" string`);
    }
    const indices = countOccurrences(original, site.anchor);
    if (indices.length === 0) {
      throw new SiteError(
        SiteErrorCode.ANCHOR_MISSING,
        `${file}: anchor not found -- the catalog is stale against this code: ${JSON.stringify(site.anchor)}`,
      );
    }
    if (indices.length > 1) {
      throw new SiteError(
        SiteErrorCode.ANCHOR_AMBIGUOUS,
        `${file}: anchor matches ${indices.length} times, so the edit is not well defined. `
        + `Extend it until it is unique: ${JSON.stringify(site.anchor)}`,
      );
    }
    if (site.replacement === site.anchor) {
      throw new SiteError(
        SiteErrorCode.NO_OP,
        `${file}: replacement is identical to the anchor, so this mutant changes nothing `
        + '(it would read SURVIVED and manufacture a false finding)',
      );
    }
    matches.push({ site, index: indices[0], end: indices[0] + site.anchor.length });
  }

  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i].index < matches[i - 1].end) {
      throw new SiteError(
        SiteErrorCode.OVERLAPPING_ANCHORS,
        `${file}: two sites of this mutant overlap in the source, so the combined edit is ambiguous`,
      );
    }
  }

  // Splice from the end so earlier indices stay valid.
  let mutated = original;
  for (const match of [...matches].reverse()) {
    mutated = mutated.slice(0, match.index)
      + match.site.replacement
      + mutated.slice(match.end);
  }
  if (mutated === original) {
    throw new SiteError(SiteErrorCode.NO_OP, `${file}: the combined edit leaves the file unchanged`);
  }

  return {
    kind: 'anchor',
    file,
    content: mutated,
    paths: [file],
    edits: matches.map((m) => ({
      anchor: m.site.anchor,
      replacement: m.site.replacement,
      line: lineOf(original, m.index),
    })),
  };
}

function resolvePatchSite(root, site) {
  if (typeof site.patch !== 'string' || site.patch.trim().length === 0) {
    throw new SiteError(SiteErrorCode.INVALID_SITE, 'patch site needs a non-empty "patch" string');
  }
  const patch = site.patch.endsWith('\n') ? site.patch : `${site.patch}\n`;
  const pathSet = patchPathSet(root, patch);

  const check = gitApplyRead(root, patch, ['--check']);
  if (!check.ok) {
    throw new SiteError(
      SiteErrorCode.PATCH_REJECTED,
      `the patch does not apply to this workspace: ${check.stderr.trim()}`,
    );
  }

  return { kind: 'patch', patch, paths: pathSet.paths, pathSet };
}

// Resolves every site of a mutant against `root` before anything is applied, so
// a bad site later in the list cannot leave earlier ones half-applied.
export function resolveSites(root, sites) {
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new SiteError(SiteErrorCode.INVALID_SITE, 'a mutant needs at least one entry in "sites"');
  }

  const anchorsByFile = new Map();
  const patchSites = [];
  for (const site of sites) {
    const hasAnchor = site && typeof site.anchor === 'string';
    const hasPatch = site && typeof site.patch === 'string';
    if (hasAnchor && hasPatch) {
      throw new SiteError(SiteErrorCode.INVALID_SITE, 'a site is either anchor+replacement or patch, not both');
    }
    if (hasPatch) { patchSites.push(site); continue; }
    if (!hasAnchor) {
      throw new SiteError(SiteErrorCode.INVALID_SITE, 'a site needs either "anchor"+"replacement" or "patch"');
    }
    if (typeof site.file !== 'string' || site.file.length === 0) {
      throw new SiteError(SiteErrorCode.INVALID_SITE, 'an anchor site needs a "file"');
    }
    const key = path.normalize(site.file);
    if (!anchorsByFile.has(key)) anchorsByFile.set(key, []);
    anchorsByFile.get(key).push(site);
  }

  const resolved = [];
  for (const [file, group] of anchorsByFile) resolved.push(resolveAnchorGroup(root, file, group));
  for (const site of patchSites) resolved.push(resolvePatchSite(root, site));

  // A patch's context lines are written against the unmutated file, so combining
  // the two forms on one path would either reject the patch or land an edit the
  // author did not write. Refuse instead of picking an order.
  const anchorFiles = new Set([...anchorsByFile.keys()]);
  for (const entry of resolved) {
    if (entry.kind !== 'patch') continue;
    for (const p of entry.paths) {
      if (anchorFiles.has(path.normalize(p))) {
        throw new SiteError(
          SiteErrorCode.MIXED_SITE_FORMS,
          `${p} is touched by both an anchor site and a patch site of the same mutant`,
        );
      }
    }
  }

  const paths = [...new Set(resolved.flatMap((entry) => entry.paths))].sort();
  return { resolved, paths };
}
