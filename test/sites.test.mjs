// Anchor resolution and patch path-set derivation -- the refusals that stop a
// malformed edit from ever reaching the tree.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SiteError, SiteErrorCode, parsePatchPaths, patchPathSet, resolveSites,
} from '../lib/sites.mjs';
import { makeRepo, write } from './helpers/tmp-repo.mjs';

function scratch(files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-sites-'));
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

function expectSiteError(fn, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught, `expected a SiteError with code ${code}, but nothing was thrown`);
  assert.ok(caught instanceof SiteError, `expected a SiteError, got ${caught.constructor.name}: ${caught.message}`);
  assert.equal(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

describe('anchor resolution', () => {
  test('a unique anchor resolves and reports its line', () => {
    const root = scratch({ 'a.mjs': 'const a = 1;\nconst target = 2;\nconst c = 3;\n' });
    try {
      const { resolved, paths } = resolveSites(root, [
        { file: 'a.mjs', anchor: 'const target = 2;', replacement: 'const target = 99;' },
      ]);
      assert.deepEqual(paths, ['a.mjs']);
      assert.equal(resolved[0].kind, 'anchor');
      assert.equal(resolved[0].edits[0].line, 2);
      assert.equal(resolved[0].content, 'const a = 1;\nconst target = 99;\nconst c = 3;\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an anchor that matches zero times is ERROR, not a best-effort edit', () => {
    const root = scratch({ 'a.mjs': 'const a = 1;\n' });
    try {
      expectSiteError(
        () => resolveSites(root, [{ file: 'a.mjs', anchor: 'nowhere', replacement: 'x' }]),
        SiteErrorCode.ANCHOR_MISSING,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an anchor that matches more than once is ERROR (the observed real-world failure)', () => {
    const root = scratch({ 'a.css': '.bar-label { color: red }\n@media x { .bar-label { color: blue } }\n' });
    try {
      const err = expectSiteError(
        () => resolveSites(root, [{ file: 'a.css', anchor: '.bar-label', replacement: '.baz' }]),
        SiteErrorCode.ANCHOR_AMBIGUOUS,
      );
      assert.match(err.message, /matches 2 times/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('overlapping occurrences still count as ambiguity', () => {
    const root = scratch({ 'a.txt': 'aaaa\n' });
    try {
      expectSiteError(
        () => resolveSites(root, [{ file: 'a.txt', anchor: 'aa', replacement: 'b' }]),
        SiteErrorCode.ANCHOR_AMBIGUOUS,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a no-op replacement is refused -- it would read SURVIVED and fake a finding', () => {
    const root = scratch({ 'a.mjs': 'const a = 1;\n' });
    try {
      expectSiteError(
        () => resolveSites(root, [{ file: 'a.mjs', anchor: 'const a = 1;', replacement: 'const a = 1;' }]),
        SiteErrorCode.NO_OP,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a missing file is ERROR', () => {
    const root = scratch({});
    try {
      expectSiteError(
        () => resolveSites(root, [{ file: 'nope.mjs', anchor: 'x', replacement: 'y' }]),
        SiteErrorCode.FILE_MISSING,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('two sites in one file are applied together, computed against the original text', () => {
    const root = scratch({ 'a.mjs': 'const first = 1;\nconst second = 2;\n' });
    try {
      const { resolved } = resolveSites(root, [
        { file: 'a.mjs', anchor: 'first = 1', replacement: 'first = 111' },
        { file: 'a.mjs', anchor: 'second = 2', replacement: 'second = 222' },
      ]);
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].content, 'const first = 111;\nconst second = 222;\n');
      assert.deepEqual(resolved[0].edits.map((e) => e.line), [1, 2]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('overlapping sites of one mutant are refused', () => {
    const root = scratch({ 'a.mjs': 'abcdef\n' });
    try {
      expectSiteError(() => resolveSites(root, [
        { file: 'a.mjs', anchor: 'abcd', replacement: 'x' },
        { file: 'a.mjs', anchor: 'cdef', replacement: 'y' },
      ]), SiteErrorCode.OVERLAPPING_ANCHORS);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a site cannot be both anchor and patch', () => {
    const root = scratch({ 'a.mjs': 'x\n' });
    try {
      expectSiteError(
        () => resolveSites(root, [{ file: 'a.mjs', anchor: 'x', replacement: 'y', patch: 'diff' }]),
        SiteErrorCode.INVALID_SITE,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an empty sites array is refused', () => {
    const root = scratch({});
    try {
      expectSiteError(() => resolveSites(root, []), SiteErrorCode.INVALID_SITE);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------- patch paths

const MODIFY_AND_CREATE = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+created
`;

const DELETE = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-doomed
`;

// The disagreement case that makes the union load-bearing rather than decorative:
// `git apply --numstat` reports ONLY the rename destination, omitting the source it
// deletes. Snapshotting from numstat alone would leave old.txt unrecorded and
// restore would not bring it back -- silent loss of a real file.
const RENAME_WITH_EDIT = `diff --git a/old.txt b/new.txt
similarity index 87%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -5,4 +5,4 @@ d
 e
 f
 g
-h
+Z
`;

describe('patch path sets', () => {
  test('modify + create: both derivations agree', () => {
    const root = scratch({ 'f.txt': 'a\nb\nc\n' });
    try {
      const set = patchPathSet(root, MODIFY_AND_CREATE);
      assert.deepEqual(set.paths, ['f.txt', 'new.txt']);
      assert.equal(set.agree, true, `disagreed: git=${set.fromGit}, parse=${set.fromParse}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('delete: the deleted path is in the set so restore can recreate it', () => {
    const root = scratch({ 'gone.txt': 'doomed\n' });
    try {
      const set = patchPathSet(root, DELETE);
      assert.deepEqual(set.paths, ['gone.txt']);
      assert.equal(set.agree, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('rename: git omits the source, the diff parse catches it, the UNION is snapshotted', () => {
    const root = scratch({ 'old.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n' });
    try {
      const set = patchPathSet(root, RENAME_WITH_EDIT);

      // The union must contain both sides, or restore loses old.txt.
      assert.deepEqual(set.paths, ['new.txt', 'old.txt']);
      // And the disagreement is recorded rather than swallowed...
      assert.equal(set.agree, false);
      assert.deepEqual(set.onlyFromParse, ['old.txt']);
      assert.deepEqual(set.onlyFromGit, []);
      // ...and correctly identified as the expected numstat behaviour, so it does
      // not read as an unexplained parser bug.
      assert.equal(set.mismatchExplainedByRename, true);
      assert.deepEqual(set.renames, [{ from: 'old.txt', to: 'new.txt' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the two derivations agree on every non-rename fixture', () => {
    const cases = [
      { patch: MODIFY_AND_CREATE, files: { 'f.txt': 'a\nb\nc\n' } },
      { patch: DELETE, files: { 'gone.txt': 'doomed\n' } },
    ];
    for (const { patch, files } of cases) {
      const root = scratch(files);
      try {
        const set = patchPathSet(root, patch);
        assert.equal(
          set.agree,
          true,
          `derivations disagreed with no rename to explain it: git=${set.fromGit}, parse=${set.fromParse}`,
        );
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  test('an unparseable patch is refused before anything is applied', () => {
    const root = scratch({});
    try {
      expectSiteError(
        () => resolveSites(root, [{ patch: 'this is not a diff at all\n' }]),
        SiteErrorCode.PATCH_UNPARSEABLE,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a patch that does not apply is refused', () => {
    const root = scratch({ 'f.txt': 'totally different content\n' });
    try {
      expectSiteError(
        () => resolveSites(root, [{ patch: MODIFY_AND_CREATE }]),
        SiteErrorCode.PATCH_REJECTED,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an anchor site and a patch site on the same file are refused', () => {
    const root = scratch({ 'f.txt': 'a\nb\nc\n' });
    try {
      expectSiteError(() => resolveSites(root, [
        { file: 'f.txt', anchor: 'a', replacement: 'z' },
        { patch: MODIFY_AND_CREATE },
      ]), SiteErrorCode.MIXED_SITE_FORMS);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('parsePatchPaths skips /dev/null and unquotes paths with spaces', () => {
    const patch = 'diff --git "a/has space.txt" "b/has space.txt"\n'
      + '--- /dev/null\n+++ "b/has space.txt"\n@@ -0,0 +1 @@\n+x\n';
    assert.deepEqual(parsePatchPaths(patch).paths, ['has space.txt']);
  });

  test('resolveSites works inside a real repository too (copy mode has no .git)', () => {
    const repo = makeRepo({ files: { 'f.txt': 'a\nb\nc\n' }, config: null, gitignore: null });
    try {
      const set = patchPathSet(repo.root, MODIFY_AND_CREATE);
      assert.deepEqual(set.paths, ['f.txt', 'new.txt']);
    } finally { repo.cleanup(); }
  });
});
