// probe's three mutation forms, and the boundary of its relaxed clean-tree gate.
//
// The patch form reaches a real verdict through the SAME resolve -> apply ->
// byte-snapshot-restore path a catalog patch site uses, so the tests that matter
// here are the ones that would catch it having grown a second, weaker path:
// a verdict really produced, and the tree really untouched afterwards -- in both
// isolation modes, since copy mode's workspace has no .git at all.
//
// The relaxation itself is probe-only. The dirty-tree pair below fails if it ever
// leaks into `run`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ExitCode } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { git, guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';

const KILLING_PATCH = `diff --git a/src/guard.mjs b/src/guard.mjs
--- a/src/guard.mjs
+++ b/src/guard.mjs
@@ -1,4 +1,4 @@
 export function isAllowed(kind) {
   if (kind === 'ollama') return true;
-  return kind === 'user-defined';
+  return false;
 }
`;

const EXPECT_FAIL = 'test/guard.test.mjs::allows user-defined backends';

const CATALOG_MUTANT = {
  id: 'm1',
  invariant: 'the user-defined-backend branch is load-bearing',
  whyNotEquivalent: 'denies a backend the guard must admit',
  sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
  expectFail: [EXPECT_FAIL],
};

function patchRepo(label, config = {}) {
  const repo = makeRepo({ files: guardFiles(), config, mutants: [CATALOG_MUTANT], label });
  write(repo.root, 'mutation.diff', KILLING_PATCH);
  return repo;
}

async function probeJson(repo, args) {
  const result = await runCli(['probe', ...args, '--json'], { cwd: repo.root });
  return { ...result, report: JSON.parse(result.stdout) };
}

describe('probe --patch-file', () => {
  test('reaches a KILLED verdict in-place and leaves the tree byte-identical', async () => {
    const repo = patchRepo('probe-patch-inplace', { isolation: 'in-place' });
    try {
      const source = readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8');
      const before = repo.status();

      const { exitCode, report } = await probeJson(repo, [
        '--patch-file', path.join(repo.root, 'mutation.diff'), '--expect-fail', EXPECT_FAIL,
      ]);

      assert.equal(exitCode, ExitCode.CLEAN);
      assert.equal(report.results[0].verdict, 'KILLED');
      assert.equal(report.results[0].mutation[0].kind, 'patch');
      assert.deepEqual(report.results[0].mutation[0].paths, ['src/guard.mjs']);
      // Restore is byte-snapshot replay, not a git undo: the file comes back
      // byte-for-byte and the tree's status is unchanged.
      assert.equal(readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8'), source);
      assert.equal(repo.status(), before);
      assert.equal(report.noTrace.ok, true);
    } finally { repo.cleanup(); }
  });

  test('works in copy mode, whose workspace has no .git, and never touches the real tree', async () => {
    const repo = patchRepo('probe-patch-copy', { isolation: 'copy' });
    try {
      const source = readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8');
      const { exitCode, report } = await probeJson(repo, [
        '--patch-file', path.join(repo.root, 'mutation.diff'), '--copy', '--expect-fail', EXPECT_FAIL,
      ]);

      assert.equal(exitCode, ExitCode.CLEAN);
      assert.equal(report.results[0].verdict, 'KILLED');
      assert.equal(report.isolation, 'copy');
      assert.notEqual(report.workspaceRoot, repo.root, 'copy mode must mutate a copy, not the repo');
      assert.equal(readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8'), source);
    } finally { repo.cleanup(); }
  });

  test('an uncommitted edit is included, because the copy is taken from the working tree', async () => {
    // The patch's context lines are written against the EDITED file, so it can
    // only apply if the probe sees the working tree rather than HEAD.
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, label: 'probe-patch-dirty' });
    try {
      write(repo.root, 'src/guard.mjs', `export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  return kind === 'user-defined'; // edited, uncommitted
}
`);
      write(repo.root, 'mutation.diff', `diff --git a/src/guard.mjs b/src/guard.mjs
--- a/src/guard.mjs
+++ b/src/guard.mjs
@@ -1,4 +1,4 @@
 export function isAllowed(kind) {
   if (kind === 'ollama') return true;
-  return kind === 'user-defined'; // edited, uncommitted
+  return false; // edited, uncommitted
 }
`);
      const { exitCode, report } = await probeJson(repo, [
        '--patch-file', path.join(repo.root, 'mutation.diff'), '--copy', '--expect-fail', EXPECT_FAIL,
      ]);
      assert.equal(exitCode, ExitCode.CLEAN);
      assert.equal(report.results[0].verdict, 'KILLED');
    } finally { repo.cleanup(); }
  });

  test('an unreadable or empty patch file is a usage error, not a crash', async () => {
    const repo = patchRepo('probe-patch-bad');
    try {
      const missing = await runCli(
        ['probe', '--patch-file', path.join(repo.root, 'nope.diff'), '--expect-fail', EXPECT_FAIL],
        { cwd: repo.root },
      );
      assert.equal(missing.exitCode, ExitCode.USAGE);
      assert.match(missing.stderr, /cannot read it/);

      write(repo.root, 'empty.diff', '   \n');
      const empty = await runCli(
        ['probe', '--patch-file', path.join(repo.root, 'empty.diff'), '--expect-fail', EXPECT_FAIL],
        { cwd: repo.root },
      );
      assert.equal(empty.exitCode, ExitCode.USAGE);
      assert.match(empty.stderr, /is empty/);
    } finally { repo.cleanup(); }
  });
});

describe('probe takes exactly one mutation form', () => {
  test('two forms at once is refused rather than one being silently ignored', async () => {
    const repo = patchRepo('probe-forms-both');
    try {
      const result = await runCli([
        'probe', '--patch-file', path.join(repo.root, 'mutation.diff'),
        '--file', 'src/guard.mjs', '--anchor', 'x', '--replace', 'y',
        '--expect-fail', EXPECT_FAIL,
      ], { cwd: repo.root });
      assert.equal(result.exitCode, ExitCode.USAGE);
      assert.match(result.stderr, /exactly one mutation form/);

      const withId = await runCli(
        ['probe', '--id', 'm1', '--patch-file', path.join(repo.root, 'mutation.diff')],
        { cwd: repo.root },
      );
      assert.equal(withId.exitCode, ExitCode.USAGE);
      assert.match(withId.stderr, /exactly one mutation form/);
    } finally { repo.cleanup(); }
  });

  test('no form at all names all three rather than guessing', async () => {
    const repo = patchRepo('probe-forms-none');
    try {
      const result = await runCli(['probe', '--expect-fail', EXPECT_FAIL], { cwd: repo.root });
      assert.equal(result.exitCode, ExitCode.USAGE);
      assert.match(result.stderr, /--file\/--anchor\/--replace/);
      assert.match(result.stderr, /--patch-file/);
      assert.match(result.stderr, /--id/);
    } finally { repo.cleanup(); }
  });

  test('the anchor form still refuses a partial site', async () => {
    const repo = patchRepo('probe-forms-partial');
    try {
      const result = await runCli(
        ['probe', '--file', 'src/guard.mjs', '--anchor', 'x', '--expect-fail', EXPECT_FAIL],
        { cwd: repo.root },
      );
      assert.equal(result.exitCode, ExitCode.USAGE);
      assert.match(result.stderr, /probe needs --replace/);
    } finally { repo.cleanup(); }
  });
});

describe('probe --id runs one catalog entry', () => {
  test('runs the entry as authored, not a re-derivation of it', async () => {
    const repo = patchRepo('probe-id');
    try {
      const { exitCode, report } = await probeJson(repo, ['--id', 'm1']);
      assert.equal(exitCode, ExitCode.CLEAN);
      assert.equal(report.command, 'probe');
      const result = report.results[0];
      assert.equal(result.id, 'm1');
      assert.equal(result.verdict, 'KILLED');
      // The entry's own fields, not probe's synthesised placeholders.
      assert.equal(result.invariant, CATALOG_MUTANT.invariant);
      assert.equal(result.whyNotEquivalent, CATALOG_MUTANT.whyNotEquivalent);
      assert.deepEqual(result.expectFail, CATALOG_MUTANT.expectFail);
    } finally { repo.cleanup(); }
  });

  test('an unknown id, more than one id, and inline expectations are each refused', async () => {
    const repo = patchRepo('probe-id-refusals');
    try {
      const unknown = await runCli(['probe', '--id', 'nope'], { cwd: repo.root });
      assert.equal(unknown.exitCode, ExitCode.USAGE);
      assert.match(unknown.stderr, /no mutant with id nope/);

      const two = await runCli(['probe', '--id', 'm1', '--id', 'm1'], { cwd: repo.root });
      assert.equal(two.exitCode, ExitCode.USAGE);
      assert.match(two.stderr, /exactly one catalog entry/);

      const overridden = await runCli(['probe', '--id', 'm1', '--expect-fail', 'test/x.test.mjs::y'], { cwd: repo.root });
      assert.equal(overridden.exitCode, ExitCode.USAGE);
      assert.match(overridden.stderr, /owns its expectFail\/expectPass/);
    } finally { repo.cleanup(); }
  });

  test('an absent catalog refuses', async () => {
    const repo = makeRepo({ files: guardFiles(), label: 'probe-id-nocatalog' });
    try {
      const result = await runCli(['probe', '--id', 'm1'], { cwd: repo.root });
      assert.equal(result.exitCode, ExitCode.USAGE);
      assert.match(result.stderr, /no catalog at/);
    } finally { repo.cleanup(); }
  });
});

describe('--learn', () => {
  test('a file-only ref as a scope hint pins refs-as-scope end to end', async () => {
    const repo = patchRepo('probe-learn-scoped');
    try {
      const { exitCode, report } = await probeJson(repo, [
        '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;',
        '--learn', '--expect-fail', 'test/guard.test.mjs',
      ]);
      assert.equal(exitCode, ExitCode.CLEAN);
      const result = report.results[0];
      assert.equal(result.verdict, 'LEARNED');
      assert.deepEqual(result.failedTests, [EXPECT_FAIL]);
      assert.equal(report.learn, true);
    } finally { repo.cleanup(); }
  });

  test('no --expect-fail at all is no longer a refusal, and falls back to baselineCommand', async () => {
    const repo = patchRepo('probe-learn-noscope');
    try {
      const { exitCode, report } = await probeJson(repo, [
        '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;',
        '--learn',
      ]);
      assert.equal(exitCode, ExitCode.CLEAN);
      const result = report.results[0];
      assert.equal(result.narrowing.command, 'node --test');
      assert.equal(result.narrowing.mode, 'whole');
    } finally { repo.cleanup(); }
  });

  test('a bogus --expect-fail ref no longer buys a bogus IMPRECISE', async () => {
    const repo = patchRepo('probe-learn-bogus-ref');
    try {
      const { exitCode, report } = await probeJson(repo, [
        '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;',
        '--learn', '--expect-fail', 'test/guard.test.mjs::rejects unknown',
      ]);
      assert.equal(exitCode, ExitCode.CLEAN);
      const result = report.results[0];
      assert.equal(result.verdict, 'LEARNED');
      assert.deepEqual(result.unexpectedFailures, []);
    } finally { repo.cleanup(); }
  });

  test('a mutation nothing covers still reports SURVIVED, not folded into LEARNED', async () => {
    const repo = makeRepo({ files: guardFiles(), label: 'probe-learn-survived' });
    try {
      write(repo.root, 'src/guard.mjs', `export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  return kind === 'user-defined';
}
export const unused = 1;
`);
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'add unused export']);

      const { exitCode, report } = await probeJson(repo, [
        '--file', 'src/guard.mjs', '--anchor', 'export const unused = 1;', '--replace', 'export const unused = 2;',
        '--learn',
      ]);
      assert.equal(exitCode, ExitCode.SURVIVORS);
      assert.equal(report.results[0].verdict, 'SURVIVED');
    } finally { repo.cleanup(); }
  });

  test('an exit-code-grade adapter refuses --learn outright', async () => {
    const repo = makeRepo({
      files: guardFiles(), config: { runner: 'exit-code', baselineCommand: 'node --test', testCommand: 'node --test' }, label: 'probe-learn-exitcode',
    });
    try {
      const result = await runCli(
        ['probe', '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;', '--learn'],
        { cwd: repo.root },
      );
      assert.equal(result.exitCode, ExitCode.USAGE);
      assert.match(result.stderr, /exit-code grade/);
    } finally { repo.cleanup(); }
  });

  test('--learn on baseline is refused', async () => {
    const repo = patchRepo('probe-learn-on-baseline');
    try {
      const result = await runCli(['baseline', '--learn'], { cwd: repo.root });
      assert.equal(result.exitCode, ExitCode.USAGE);
      assert.match(result.stderr, /only applies to/);
    } finally { repo.cleanup(); }
  });
});

describe("probe's relaxed clean-tree gate does not leak into run", () => {
  test('on the same dirty tree, probe --id warns and proceeds while run --id refuses', async () => {
    const repo = patchRepo('probe-dirty-boundary', { isolation: 'copy' });
    try {
      // Dirty in a way that does not disturb the mutant's anchor or its test.
      appendFileSync(path.join(repo.root, 'src/unrelated.mjs'), 'export const x = 1;\n');

      const probed = await probeJson(repo, ['--id', 'm1', '--copy']);
      assert.equal(probed.exitCode, ExitCode.CLEAN, 'probe must proceed on a dirty tree');
      assert.equal(probed.report.results[0].verdict, 'KILLED');
      assert.match(probed.stderr, /warning: worktree has uncommitted or untracked changes/);

      const ran = await runCli(['run', '--id', 'm1', '--copy', '--json'], { cwd: repo.root });
      assert.equal(ran.exitCode, ExitCode.GATE_FAILED, 'run must still refuse the same dirty tree');
      const report = JSON.parse(ran.stdout);
      assert.equal(report.gates.cleanTree.outcome, 'failed');
      assert.equal(report.gates.cleanTree.code, 'dirty-tree');
      assert.deepEqual(report.results, []);
    } finally { repo.cleanup(); }
  });

  test('probe --patch-file warns on a dirty tree too, and still records a result file', async () => {
    const repo = patchRepo('probe-dirty-patch', { isolation: 'copy' });
    try {
      appendFileSync(path.join(repo.root, 'src/unrelated.mjs'), 'export const x = 1;\n');
      const { exitCode, report, stderr } = await probeJson(repo, [
        '--patch-file', path.join(repo.root, 'mutation.diff'), '--copy', '--expect-fail', EXPECT_FAIL,
      ]);
      assert.equal(exitCode, ExitCode.CLEAN);
      assert.match(stderr, /warning: worktree has uncommitted or untracked changes/);
      assert.match(report.resultsFile, /\.mutation\/results\/probe-/);
    } finally { repo.cleanup(); }
  });
});
