// `candidates` -- the mechanical antidote to biased target selection.
//
// It lists hunks no catalog mutant covers. It must never read as a mandate to
// author one mutant per hunk, so the advisory wording is asserted alongside the
// coverage arithmetic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listCandidates, mergeBase, parseHunks } from '../lib/candidates.mjs';
import { runCli } from './helpers/cli.mjs';
import { git, guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

// A repo with a `base` branch, then changes on top of it: two separate hunks in
// one file plus a new file.
function repoWithDiff(label) {
  const repo = makeRepo({ files: guardFiles(), label });
  git(repo.root, ['branch', 'base']);

  writeFileSync(path.join(repo.root, 'src/guard.mjs'), `export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  if (kind === 'blocked') return false;
  return kind === 'user-defined';
}

export function limit(n) {
  return n > 10 ? 10 : n;
}
`);
  git(repo.root, ['add', '-A']);
  git(repo.root, ['commit', '-qm', 'changes']);
  return repo;
}

const COVERING = {
  id: 'covers-blocked',
  invariant: 'the blocked short-circuit is load-bearing',
  sites: [{ file: 'src/guard.mjs', anchor: "kind === 'blocked'", replacement: 'false' }],
  expectFail: ['test/guard.test.mjs::rejects unknown'],
  whyNotEquivalent: 'never short-circuiting admits a kind the guard must reject',
};

describe('hunk parsing', () => {
  test('reads file, start and end from a unified=0 diff', () => {
    const hunks = parseHunks([
      'diff --git a/f.mjs b/f.mjs',
      '--- a/f.mjs',
      '+++ b/f.mjs',
      '@@ -3,0 +4,2 @@',
      '+added one',
      '+added two',
      '@@ -10,1 +12,0 @@',
      '-removed',
    ].join('\n'));

    assert.equal(hunks.length, 2);
    assert.deepEqual(
      { file: hunks[0].file, start: hunks[0].start, end: hunks[0].end, added: hunks[0].added },
      { file: 'f.mjs', start: 4, end: 5, added: ['added one', 'added two'] },
    );
    // A pure deletion is kept as a zero-width marker rather than dropped.
    assert.equal(hunks[1].start, 12);
    assert.equal(hunks[1].end, 12);
  });

  test('skips /dev/null so a deleted file does not become a phantom hunk', () => {
    const hunks = parseHunks('--- a/gone.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
    assert.deepEqual(hunks, []);
  });
});

describe('coverage', () => {
  test('a hunk with a resolving catalog site is covered; the rest are listed', () => {
    const repo = repoWithDiff('cand-cover');
    try {
      const listing = listCandidates({ repoRoot: repo.root, base: 'base', mutants: [COVERING] });

      assert.ok(listing.hunkCount >= 2, `expected several hunks, got ${listing.hunkCount}`);
      assert.equal(listing.covered.length, 1);
      assert.deepEqual(listing.covered[0].coveredBy, ['covers-blocked']);
      assert.equal(listing.covered[0].file, 'src/guard.mjs');

      assert.ok(listing.uncovered.length >= 1, 'the limit() addition is not covered by any mutant');
      const uncoveredPreviews = listing.uncovered.flatMap((h) => h.preview).join(' ');
      assert.match(uncoveredPreviews, /limit/);
      for (const hunk of listing.uncovered) assert.deepEqual(hunk.coveredBy, []);
    } finally { repo.cleanup(); }
  });

  test('an empty catalog leaves every hunk uncovered -- round 1', () => {
    const repo = repoWithDiff('cand-empty');
    try {
      const listing = listCandidates({ repoRoot: repo.root, base: 'base', mutants: [] });
      assert.equal(listing.covered.length, 0);
      assert.equal(listing.uncovered.length, listing.hunkCount);
    } finally { repo.cleanup(); }
  });

  test('UNCOMMITTED hunks are included -- a worker may not have committed yet', () => {
    const repo = repoWithDiff('cand-dirty');
    try {
      appendFileSync(
        path.join(repo.root, 'src/guard.mjs'),
        '\nexport function uncommittedAddition() { return 1; }\n',
      );
      const listing = listCandidates({ repoRoot: repo.root, base: 'base', mutants: [] });
      const previews = listing.uncovered.flatMap((h) => h.preview).join(' ');
      assert.match(previews, /uncommittedAddition/);
    } finally { repo.cleanup(); }
  });

  test('a mutant whose anchor no longer resolves covers nothing, and is reported as stale', () => {
    const repo = repoWithDiff('cand-stale');
    try {
      const listing = listCandidates({
        repoRoot: repo.root,
        base: 'base',
        mutants: [{ ...COVERING, id: 'stale', sites: [{ file: 'src/guard.mjs', anchor: 'long gone', replacement: 'x' }] }],
      });
      assert.equal(listing.covered.length, 0);
      assert.equal(listing.staleAnchors.length, 1);
      assert.equal(listing.staleAnchors[0].id, 'stale');
      assert.equal(listing.staleAnchors[0].unresolved[0].error, 'anchor-missing');
    } finally { repo.cleanup(); }
  });

  test('a patch-site mutant covers the lines its own hunks touch', () => {
    const repo = repoWithDiff('cand-patch');
    try {
      const listing = listCandidates({
        repoRoot: repo.root,
        base: 'base',
        mutants: [{
          ...COVERING,
          id: 'patch-mutant',
          sites: [{
            patch: 'diff --git a/src/guard.mjs b/src/guard.mjs\n--- a/src/guard.mjs\n+++ b/src/guard.mjs\n'
              + "@@ -7,3 +7,3 @@ export function limit(n) {\n-  return n > 10 ? 10 : n;\n+  return n;\n",
          }],
        }],
      });
      assert.ok(
        listing.covered.some((h) => h.file === 'src/guard.mjs' && h.start <= 9 && h.end >= 7),
        'the limit() hunk should now read as covered',
      );
    } finally { repo.cleanup(); }
  });
});

describe('advisory framing', () => {
  test('the output says it lists rather than mandates, and rejects one-per-hunk', () => {
    const repo = repoWithDiff('cand-advisory');
    try {
      const listing = listCandidates({ repoRoot: repo.root, base: 'base', mutants: [] });
      assert.match(listing.advisory, /ADVISORY/);
      assert.match(listing.advisory, /it lists, you target/i);
      assert.match(listing.advisory, /Do NOT author one mutant per hunk/);
      assert.match(listing.advisory, /exhaustive sweep/);
    } finally { repo.cleanup(); }
  });
});

describe('an absent catalog is tolerated, unlike run/validate', () => {
  test('the CLI lists the whole diff with no catalog file at all', async () => {
    // Round 1 of a review: the reviewer has authored nothing yet, so an empty or
    // entirely absent catalog is `candidates`' NORMAL state -- it takes the
    // catalog as coverage context, not as the thing it acts on. `run` and
    // `validate` require one and refuse without it, which is why this caller
    // deliberately keeps plain loadCatalog rather than requireCatalog. Nothing
    // else pins that difference, so collapsing the two would break round 1 here.
    const repo = repoWithDiff('cand-nocatalog');
    try {
      assert.equal(
        existsSync(path.join(repo.root, '.mutation', 'mutants.json')),
        false,
        'the fixture must genuinely have no catalog file, or this test proves nothing',
      );

      const result = await runCli(['candidates', '--base', 'base', '--json'], { cwd: repo.root });
      assert.equal(result.exitCode, 0, result.stderr);

      const listing = JSON.parse(result.stdout);
      assert.equal(listing.catalogMutants, 0);
      assert.ok(listing.hunkCount > 0, 'the diff really does have hunks to list');
      assert.equal(listing.uncovered.length, listing.hunkCount, 'with no catalog, every hunk is uncovered');
      assert.deepEqual(listing.covered, []);
    } finally { repo.cleanup(); }
  });
});

describe('base resolution', () => {
  test('a bogus base gives an actionable error', () => {
    const repo = repoWithDiff('cand-bogus');
    try {
      assert.throws(
        () => mergeBase(repo.root, 'no-such-branch'),
        /cannot find a merge base between "no-such-branch" and HEAD/,
      );
    } finally { repo.cleanup(); }
  });
});
