// `candidates --base <branch>`: diff hunks that no catalog mutant covers.
//
// ADVISORY, AND THAT IS THE POINT. It lists; the reviewer targets. The survivors
// that mattered historically were targets nobody thought to pick -- an implementer
// picks mutants its own tests already catch, not dishonestly but by construction --
// so this is the mechanical antidote to biased selection. It is NOT a sweep: one
// mutant per hunk would be the exhaustive mutation testing this design rejects, at
// large wall-clock cost, answering a question nobody asked.
//
// The diff is taken from the merge base to the WORKING TREE, not to HEAD:
// uncommitted work in a worker's tree is normal, not exceptional, and hunks a
// worker has not committed yet are exactly the ones under review. Untracked files
// do not appear -- git cannot diff what it does not know about.

import { execFileSync } from 'node:child_process';

import { SiteError, parsePatchPaths, resolveSites } from './sites.mjs';

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function mergeBase(repoRoot, base) {
  try {
    return git(repoRoot, ['merge-base', base, 'HEAD']).trim();
  } catch (err) {
    throw new Error(
      `cannot find a merge base between ${JSON.stringify(base)} and HEAD in ${repoRoot}. `
      + `Is ${JSON.stringify(base)} a real branch or commit? (${(err.stderr?.toString?.() ?? err.message).trim()})`,
    );
  }
}

// Parses `git diff --unified=0` into one entry per hunk.
export function parseHunks(diffText) {
  const hunks = [];
  let file = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).split('\t')[0].trim();
      file = value === '/dev/null' ? null : value.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match && file) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        hunks.push({
          file,
          start,
          // A pure deletion reports 0 lines at `start`; keep it as a zero-width
          // marker at that point rather than dropping it.
          end: count === 0 ? start : start + count - 1,
          lines: count,
          added: [],
        });
      }
      continue;
    }
    if (hunks.length && line.startsWith('+') && !line.startsWith('+++')) {
      hunks[hunks.length - 1].added.push(line.slice(1));
    }
  }
  return hunks;
}

function patchRanges(patchText) {
  const ranges = [];
  let file = null;
  for (const line of patchText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).split('\t')[0].trim();
      file = value === '/dev/null' ? null : value.replace(/^b\//, '');
      continue;
    }
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (match && file) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      ranges.push({ file, start, end: count === 0 ? start : start + count - 1 });
    }
  }
  if (!ranges.length) {
    // A patch with no parseable hunk header still touches its declared paths;
    // treat the whole file as covered rather than reporting it as uncovered.
    for (const p of parsePatchPaths(patchText).paths) {
      ranges.push({ file: p, start: 1, end: Number.MAX_SAFE_INTEGER });
    }
  }
  return ranges;
}

// Where each catalog mutant actually sits, so coverage is decided against
// resolved locations rather than against what the catalog claims.
export function mutantRanges(repoRoot, mutants) {
  const byMutant = new Map();
  for (const mutant of mutants) {
    const ranges = [];
    const unresolved = [];
    for (const site of mutant.sites ?? []) {
      if (typeof site.patch === 'string') {
        ranges.push(...patchRanges(site.patch));
        continue;
      }
      try {
        const { resolved } = resolveSites(repoRoot, [site]);
        for (const entry of resolved) {
          for (const edit of entry.edits ?? []) {
            ranges.push({ file: entry.file, start: edit.line, end: edit.line });
          }
        }
      } catch (err) {
        // A stale anchor cannot cover anything -- and saying so is useful, since
        // it means the catalog no longer matches the code.
        unresolved.push({
          file: site.file ?? null,
          error: err instanceof SiteError ? err.code : 'unresolved',
        });
      }
    }
    byMutant.set(mutant.id, { ranges, unresolved });
  }
  return byMutant;
}

function overlaps(hunk, range) {
  return range.file === hunk.file && range.start <= hunk.end && range.end >= hunk.start;
}

// A hunk this size is rare but real: adjacent changes (e.g. an existing edit
// abutting a fresh, uncommitted addition with no unchanged line between them)
// coalesce into one git hunk. Slicing the first 3 raw lines would silently drop
// the newest content -- exactly the tail a reviewer most needs to see -- so a
// long hunk keeps its head AND its tail instead.
function hunkPreview(added) {
  const lines = added.map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 3) return lines;
  return [lines[0], lines[1], '…', lines[lines.length - 1]];
}

export function listCandidates({ repoRoot, base, mutants = [] }) {
  const mergeBaseSha = mergeBase(repoRoot, base);
  const diff = git(repoRoot, ['diff', '--unified=0', mergeBaseSha]);
  const hunks = parseHunks(diff);
  const ranges = mutantRanges(repoRoot, mutants);

  const covered = [];
  const uncovered = [];
  for (const hunk of hunks) {
    const coveringIds = [];
    for (const [id, entry] of ranges) {
      if (entry.ranges.some((range) => overlaps(hunk, range))) coveringIds.push(id);
    }
    const record = {
      file: hunk.file,
      start: hunk.start,
      end: hunk.end,
      lines: hunk.lines,
      preview: hunkPreview(hunk.added),
      coveredBy: coveringIds,
    };
    if (coveringIds.length) covered.push(record); else uncovered.push(record);
  }

  const staleAnchors = [...ranges.entries()]
    .filter(([, entry]) => entry.unresolved.length)
    .map(([id, entry]) => ({ id, unresolved: entry.unresolved }));

  return {
    base,
    mergeBase: mergeBaseSha,
    hunkCount: hunks.length,
    covered,
    uncovered,
    staleAnchors,
    advisory: 'ADVISORY: it lists, you target. Do NOT author one mutant per hunk -- that is an '
      + 'exhaustive sweep, not this practice. Select the hunks you judge invariant-bearing (the ones a '
      + 'test claims to pin).',
  };
}
