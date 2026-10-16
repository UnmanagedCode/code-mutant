// `validate`: the pre-flight that resolves the catalog and runs NOTHING.
//
// Two properties carry the command, and each has a test that fails if it is lost:
//   - it executes no command (a counter file that must never appear), and
//   - its output cannot be read as a verdict or as a passed gate.
// The rest pin the severity contract: which conditions are problems (exit 4) and
// which are warnings (exit 0, always).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { discoverCanaryTargets, trackedFiles } from '../lib/gates.mjs';
import { validateCatalog } from '../lib/validate.mjs';
import { runCli } from './helpers/cli.mjs';
import { git, guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');

const GOOD = {
  id: 'good',
  invariant: 'the user-defined-backend branch is load-bearing',
  whyNotEquivalent: 'denies a backend the guard must admit',
  sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
};

function validate(repo, args = []) {
  return runCli(['validate', ...args], { cwd: repo.root });
}

async function validateJson(repo) {
  const result = await validate(repo, ['--json']);
  return { ...result, report: JSON.parse(result.stdout) };
}

describe('validate runs no tests', () => {
  test('never invokes the test command, even once', async () => {
    // The fake command writes a counter file on every invocation. If validate
    // routed anything through execute()/measure() -- a baseline, a canary, a
    // narrow baseline -- this file would exist.
    //
    // The counter lives in its own temp dir, NOT under the repo: a path the fake
    // could not write to would make this assertion pass whether or not the command
    // ran. `baseline` on the same fixture is asserted to create it, which is what
    // proves the fake really is wired up and this check has teeth.
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-test-noexec-'));
    const state = path.join(stateDir, 'invocations');
    const config = {
      baselineCommand: `node ${STAGED}`,
      testCommand: `node ${STAGED} {tests}`,
    };
    const repo = makeRepo({ files: guardFiles(), config, mutants: [GOOD], label: 'validate-noexec' });
    try {
      const result = await runCli(['validate'], { cwd: repo.root, env: { CM_FAKE_STATE: state } });
      assert.equal(result.exitCode, 0, result.stdout + result.stderr);
      assert.equal(existsSync(state), false, 'validate must not execute the test command at all');

      await runCli(['baseline'], { cwd: repo.root, env: { CM_FAKE_STATE: state } });
      assert.equal(existsSync(state), true, 'control: the fake command really does record its invocations');
    } finally {
      repo.cleanup();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('leaves the worktree byte-identical, including for a patch site it checked', async () => {
    const patch = `diff --git a/src/guard.mjs b/src/guard.mjs
--- a/src/guard.mjs
+++ b/src/guard.mjs
@@ -1,4 +1,4 @@
 export function isAllowed(kind) {
   if (kind === 'ollama') return true;
-  return kind === 'user-defined';
+  return false;
 }
`;
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [{ ...GOOD, id: 'p', sites: [{ patch }] }],
      label: 'validate-notrace',
    });
    try {
      const before = repo.status();
      const result = await validate(repo);
      assert.equal(result.exitCode, 0, result.stdout);
      assert.match(result.stdout, /patch touching src\/guard\.mjs/);
      assert.equal(repo.status(), before, 'validate resolves with --check only; it must never apply');
    } finally { repo.cleanup(); }
  });
});

describe('validate reports resolution refusals', () => {
  test('a stale anchor is a problem, and the healthy mutant beside it still resolves', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [
        { ...GOOD, id: 'stale', sites: [{ file: 'src/guard.mjs', anchor: 'THIS TEXT IS GONE', replacement: 'x' }] },
        GOOD,
      ],
      label: 'validate-stale',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 4);
      const byId = Object.fromEntries(report.mutants.map((m) => [m.id, m]));
      assert.equal(byId.stale.resolves, false);
      assert.deepEqual(byId.stale.issues.map((i) => i.code), ['anchor-missing']);
      // The loop must catch per mutant, not abort on the first failure.
      assert.equal(byId.good.resolves, true, 'a later mutant must still be reported after an earlier one fails');
      assert.deepEqual(byId.good.issues, []);
      assert.equal(report.summary.withProblems, 1);
      assert.equal(report.summary.resolves, 1);
    } finally { repo.cleanup(); }
  });

  test('ambiguous anchor and no-op replacement each report their own code', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [
        { ...GOOD, id: 'ambiguous', sites: [{ file: 'src/guard.mjs', anchor: 'kind', replacement: 'k' }] },
        {
          ...GOOD,
          id: 'noop',
          sites: [{
            file: 'src/guard.mjs',
            anchor: "return kind === 'user-defined';",
            replacement: "return kind === 'user-defined';",
          }],
        },
      ],
      label: 'validate-codes',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 4);
      const codes = Object.fromEntries(report.mutants.map((m) => [m.id, m.issues.map((i) => i.code)]));
      assert.deepEqual(codes.ambiguous, ['anchor-ambiguous']);
      assert.deepEqual(codes.noop, ['no-op']);
    } finally { repo.cleanup(); }
  });

  test('a patch that no longer applies is patch-rejected', async () => {
    const patch = `diff --git a/src/guard.mjs b/src/guard.mjs
--- a/src/guard.mjs
+++ b/src/guard.mjs
@@ -1,3 +1,3 @@
 export function neverWrittenThisWay(kind) {
-  return 1;
+  return 2;
 }
`;
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [{ ...GOOD, id: 'p', sites: [{ patch }] }],
      label: 'validate-patch-reject',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 4);
      assert.deepEqual(report.mutants[0].issues.map((i) => i.code), ['patch-rejected']);
    } finally { repo.cleanup(); }
  });

  test('a .mutation/ that is not gitignored is a catalog-level problem', async () => {
    const repo = makeRepo({
      files: guardFiles(), gitignore: '', mutants: [GOOD], label: 'validate-notignored',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 4);
      assert.deepEqual(report.issues.map((i) => i.code), ['mutation-dir-not-ignored']);
      // Catalog-level, not attributed to a mutant.
      assert.equal(report.mutants[0].resolves, true);
    } finally { repo.cleanup(); }
  });
});

describe('validate checks expectFail shape against the configured adapter', () => {
  test('counted grade with no expectFail is a PROBLEM: the mutant can never read KILLED', async () => {
    // Observed against a real `run`: such a mutant reads SURVIVED when nothing
    // catches the mutation (a blocking, un-arbitrable finding) and IMPRECISE when
    // something does -- never KILLED.
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [{ ...GOOD, id: 'nofail', expectFail: undefined, expectPass: ['test/guard.test.mjs::allows ollama'] }],
      label: 'validate-nofail',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 4);
      const issue = report.mutants[0].issues.find((i) => i.code === 'no-expect-fail');
      assert.ok(issue, 'expected a no-expect-fail issue');
      assert.equal(issue.severity, 'problem');
      assert.equal(report.mutants[0].resolves, false);
      // The dead-end refusal must point at its own way out.
      assert.match(issue.detail, /run --learn/);
    } finally { repo.cleanup(); }
  });

  test('a ref naming a file that does not exist is a warning, and does not change the exit code', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [{ ...GOOD, expectFail: ['test/typo.test.mjs::allows ollama'] }],
      label: 'validate-badref',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.mutants[0].issues.find((i) => i.code === 'ref-file-missing');
      assert.ok(issue, 'expected a ref-file-missing issue');
      assert.equal(issue.severity, 'warning');
      assert.equal(exitCode, 0, 'a warning must never fail the exit code');
      assert.equal(report.mutants[0].resolves, true);
    } finally { repo.cleanup(); }
  });

  test('the file check covers expectPass refs, not only expectFail', async () => {
    // GOOD's expectFail names a file that exists, so the only ref that can raise
    // anything here is the expectPass one -- both halves of the reference list
    // are narrowed against and both must be checked.
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [{ ...GOOD, expectPass: ['test/gone.test.mjs::something'] }],
      label: 'validate-badref-expectpass',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      const raised = report.mutants[0].issues.filter((i) => i.code === 'ref-file-missing');
      assert.equal(raised.length, 1, 'expected the expectPass ref to be checked');
      assert.match(raised[0].detail, /test\/gone\.test\.mjs/);
      assert.equal(raised[0].severity, 'warning');
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('a real ref raises nothing', async () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-goodref' });
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 0);
      assert.deepEqual(report.mutants[0].issues, []);
      assert.equal(report.summary.warnings, 0);
    } finally { repo.cleanup(); }
  });

  test('dotnet: a file::name ref is flagged, an FQN is not -- and no file check is applied', async () => {
    // The file-existence check must NOT run for an adapter whose references are
    // not paths: `proj.UnitTest1.Subtracts` is not a file, and reporting it as
    // missing would be a false finding on a correct catalog.
    const repo = makeRepo({
      files: guardFiles(),
      config: { runner: 'dotnet', baselineCommand: 'dotnet test', testCommand: 'dotnet test {tests}' },
      mutants: [
        { ...GOOD, id: 'fqn', expectFail: ['proj.UnitTest1.Subtracts'] },
        { ...GOOD, id: 'pathy', expectFail: ['test/guard.test.mjs::allows ollama'] },
      ],
      label: 'validate-dotnet',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      const byId = Object.fromEntries(report.mutants.map((m) => [m.id, m]));
      assert.deepEqual(byId.fqn.issues, [], 'an FQN must not be checked for existence on disk');
      const issue = byId.pathy.issues.find((i) => i.code === 'ref-shape');
      assert.ok(issue, 'expected a ref-shape issue for a file::name ref under dotnet');
      assert.equal(issue.severity, 'warning');
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('exit-code grade: listed refs are reported as unused, and the run still exits 0', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { runner: 'exit-code', baselineCommand: 'true', testCommand: 'true' },
      mutants: [GOOD],
      label: 'validate-exitcode',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.mutants[0].issues.find((i) => i.code === 'refs-ignored');
      assert.ok(issue, 'expected a refs-ignored issue');
      assert.equal(issue.severity, 'warning');
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('narrowTo:"names" that will not take effect is a warning carrying the reason', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      // A file-only reference names no individual test, so name-level narrowing
      // has nothing to filter on and planNarrowing downgrades it.
      mutants: [{ ...GOOD, narrowTo: 'names', expectFail: ['test/guard.test.mjs'] }],
      label: 'validate-downgrade',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.mutants[0].issues.find((i) => i.code === 'narrow-downgraded');
      assert.ok(issue, 'expected a narrow-downgraded issue');
      assert.equal(issue.severity, 'warning');
      assert.match(issue.detail, /names an individual test/);
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('a mutant with no expectFail AND no expectPass reports one cause, not two', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      mutants: [{ ...GOOD, expectFail: undefined }],
      label: 'validate-norefs',
    });
    try {
      const { report } = await validateJson(repo);
      assert.deepEqual(
        report.mutants[0].issues.map((i) => i.code),
        ['no-expect-fail'],
        'planNarrowing throwing for the same reason must not be reported as a second problem',
      );
    } finally { repo.cleanup(); }
  });
});

// The pre-flight's whole job is to predict what `run` would decide. A custom
// adapter that `run` refuses outright is the one thing it must not stay silent
// about -- before this, such a catalog validated clean at exit 0 while `run` on
// the same tree exited 2.
describe('validate reports the adapter-level canary prerequisites', () => {
  function customRepo(label, parseBody) {
    const repo = makeRepo({
      files: guardFiles(),
      config: { runner: 'custom' },
      mutants: [GOOD],
      label,
    });
    write(repo.root, 'harness/mutation/parse.mjs', parseBody);
    return repo;
  }

  const NODE_TEST_MODULE = pathToFileURL(path.join(HERE, '..', 'lib', 'adapters', 'node-test.mjs')).href;

  test('a counted parser with no canary() is a PROBLEM -- run refuses it before the baseline', async () => {
    const repo = customRepo('validate-no-canary', `export { parse } from ${JSON.stringify(NODE_TEST_MODULE)};\n`);
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.issues.find((i) => i.code === 'adapter-no-canary');
      assert.ok(issue, 'expected an adapter-no-canary issue');
      assert.equal(issue.severity, 'problem');
      assert.ok(report.summary.problems >= 1);
      assert.equal(exitCode, 4);
    } finally { repo.cleanup(); }
  });

  test('a counted parser with no testFilePatterns is a WARNING, and never fails the exit code', async () => {
    const repo = customRepo(
      'validate-no-patterns',
      `export { parse, canary } from ${JSON.stringify(NODE_TEST_MODULE)};\n`,
    );
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.issues.find((i) => i.code === 'adapter-no-test-patterns');
      assert.ok(issue, 'expected an adapter-no-test-patterns issue');
      assert.equal(issue.severity, 'warning');
      // BOTH halves: without the second this reads as a defect when it is a
      // degradation of one command only.
      assert.match(issue.detail, /cannot find a target file/);
      assert.match(issue.detail, /run` works/);
      assert.equal(report.summary.problems, 0);
      assert.equal(exitCode, 0, 'a warning must never fail the exit code');
    } finally { repo.cleanup(); }
  });

  test('testFilePatterns that match no tracked file warn the same as none at all', async () => {
    // The two shapes leave `baseline` in the identical state -- no candidate to
    // inject into -- so keying the warning on the patterns being EMPTY let this
    // one validate clean at exit 0 while `baseline` on the same tree exited 2.
    // Checked with the gate's own discovery call, which runs no command.
    const repo = customRepo('validate-patterns-match-nothing', `
      export { parse, canary } from ${JSON.stringify(NODE_TEST_MODULE)};
      export const testFilePatterns = ['spec/**/*.spec.js'];
    `);
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.issues.find((i) => i.code === 'adapter-no-test-patterns');
      assert.ok(issue, 'expected an adapter-no-test-patterns issue');
      assert.equal(issue.severity, 'warning');
      assert.match(issue.detail, /match no tracked file/);
      assert.match(issue.detail, /spec\/\*\*\/\*\.spec\.js/, 'name the patterns that matched nothing');
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('testFilePatterns that DO match raise nothing', async () => {
    const repo = customRepo('validate-patterns-match', `
      export { parse, canary } from ${JSON.stringify(NODE_TEST_MODULE)};
      export const testFilePatterns = ['test/**/*.test.mjs'];
    `);
    try {
      const { exitCode, report } = await validateJson(repo);
      assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('an adapter missing both exports learns both facts in one pass', async () => {
    const repo = customRepo('validate-missing-both', `export { parse } from ${JSON.stringify(NODE_TEST_MODULE)};\n`);
    try {
      const { exitCode, report } = await validateJson(repo);
      const codes = report.issues.map((i) => i.code);
      assert.ok(codes.includes('adapter-no-canary'), codes.join(', '));
      assert.ok(
        codes.includes('adapter-no-test-patterns'),
        'the canary problem must not hide the patterns warning -- one pass, one fix list',
      );
      assert.equal(exitCode, 4);
    } finally { repo.cleanup(); }
  });

  test('a run-level problem is not reported as a catalog fault', async () => {
    // The catalog here resolves perfectly; the ADAPTER is what `run` refuses. The
    // human-readable tail used to print "0 with a problem" directly above "the
    // catalog does not resolve against this tree", pointing the reader at the one
    // file that is fine.
    const repo = customRepo('validate-run-level-prose', `export { parse } from ${JSON.stringify(NODE_TEST_MODULE)};\n`);
    try {
      const { exitCode, stdout } = await validate(repo);
      assert.equal(exitCode, 4);
      assert.match(stdout, /1 resolve, 0 with a problem/);
      assert.match(stdout, /run-level problem\(s\) above, outside the catalog/);
      assert.doesNotMatch(
        stdout,
        /the catalog does not resolve against this tree/,
        'the exit line must not diagnose a catalog that resolves',
      );
      assert.match(stdout, /exit 4:.*run-level problem/);
    } finally { repo.cleanup(); }
  });

  test('an exit-code parser raises neither: it needs neither export', async () => {
    const repo = customRepo(
      'validate-exit-code',
      "export const grade = 'exit-code';\nexport function parse() { return { failedTests: [] }; }\n",
    );
    try {
      const { report } = await validateJson(repo);
      const codes = report.issues.map((i) => i.code);
      assert.ok(!codes.includes('adapter-no-canary'), codes.join(', '));
      assert.ok(!codes.includes('adapter-no-test-patterns'), codes.join(', '));
    } finally { repo.cleanup(); }
  });

  test('the problem names a malformed grade instead of calling it counted', async () => {
    // The gate's twin message is pinned in test/gates.test.mjs; this is the other
    // direction. Both are generated from describeGrade() so they cannot drift, and
    // "is counted grade" about an adapter declaring `grade = "Counted"` would send
    // the reader past the typo that is the actual bug. loadAdapter normalises its
    // own grades, so a direct call is the only way to reach this.
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-bad-grade' });
    try {
      const base = await loadAdapter('node-test', { configDir: path.join(repo.root, 'harness', 'mutation') });
      const report = validateCatalog({
        repoRoot: repo.root,
        config: { testCommand: 'node --test {tests}' },
        adapter: { ...base, name: 'hand-built', grade: 'Counted', canary: null },
        catalog: { path: '.mutation/mutants.json', mutants: [] },
      });
      const issue = report.issues.find((i) => i.code === 'adapter-no-canary');
      assert.ok(issue, 'expected an adapter-no-canary issue');
      assert.match(issue.detail, /runs at grade "Counted", which is not a grade the runner knows/);
      assert.doesNotMatch(issue.detail, /runs at counted grade/);
    } finally { repo.cleanup(); }
  });

  test('a git failure is not reported as "your patterns match nothing"', async () => {
    // `trackedFiles` swallows a git failure -- ENOBUFS on a monorepo past
    // execFileSync's buffer, or no repo at all -- and returns no candidates. The
    // gate tolerates that; validate must not turn it into a specific false claim
    // about the adapter's patterns. A directory that is not a git repo stands in
    // for the failure, deterministically and with no network or size fixture.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-test-nogit-'));
    try {
      assert.equal(trackedFiles(dir), null, 'a git failure must be distinguishable from an empty repo');
      const withPatterns = await loadAdapter('node-test', { configDir: dir });
      assert.ok(withPatterns.testFilePatterns.length, 'fixture assumption: node-test declares patterns');
      assert.deepEqual(
        discoverCanaryTargets({ workspaceRoot: dir, repoRoot: dir, adapter: withPatterns }),
        [],
        'the gate stays tolerant of a git failure',
      );

      const report = validateCatalog({
        repoRoot: dir,
        config: { testCommand: 'node --test {tests}' },
        adapter: withPatterns,
        catalog: { path: path.join(dir, 'mutants.json'), mutants: [] },
      });
      assert.ok(
        !report.issues.some((i) => i.code === 'adapter-no-test-patterns'),
        'patterns cannot be judged when git could not list the tree',
      );

      // The other half needs no git at all, so it is still reported.
      const noPatterns = validateCatalog({
        repoRoot: dir,
        config: { testCommand: 'node --test {tests}' },
        adapter: { ...withPatterns, testFilePatterns: [] },
        catalog: { path: path.join(dir, 'mutants.json'), mutants: [] },
      });
      assert.ok(noPatterns.issues.some((i) => i.code === 'adapter-no-test-patterns'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a shipped adapter raises neither', async () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-shipped-adapter' });
    try {
      const { exitCode, report } = await validateJson(repo);
      const codes = report.issues.map((i) => i.code);
      assert.ok(!codes.includes('adapter-no-canary'), codes.join(', '));
      assert.ok(!codes.includes('adapter-no-test-patterns'), codes.join(', '));
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });
});

describe('validate never reads as a verdict or as a passed gate', () => {
  test('a clean catalog exits 0 saying the catalog resolves, not that anything passed', async () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-clean' });
    try {
      const result = await validate(repo);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /NO TESTS WERE RUN \(ranTests: false\)/);
      assert.match(result.stdout, /establishes NO trust gate/);
      assert.match(
        result.stdout,
        /exit 0: every catalog mutant resolves against this tree\. No test was run and no trust gate was established\./,
      );
      // The verdict and gate-outcome vocabulary must not appear in output that
      // measured nothing. (The banner names the gates it did NOT establish, which
      // is the opposite failure and is asserted above.)
      for (const word of ['KILLED', 'SURVIVED', 'IMPRECISE', 'TIMEOUT', 'PASSED', 'Trust gates']) {
        assert.equal(result.stdout.includes(word), false, `validate output must not contain ${word}`);
      }
    } finally { repo.cleanup(); }
  });

  test('--json carries ranTests:false and none of the run report keys', async () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-json' });
    try {
      const { report } = await validateJson(repo);
      assert.equal(report.command, 'validate');
      assert.equal(report.ranTests, false);
      assert.equal(report.gatesEstablished, false);
      assert.equal(report.exitCode, 0);
      for (const key of ['results', 'gates', 'noTrace', 'mutatedSha']) {
        assert.equal(key in report, false, `a validate report must not carry a "${key}" key`);
      }
      assert.equal('survivors' in report.summary, false);
      assert.equal(JSON.stringify(report).includes('"verdict"'), false);
    } finally { repo.cleanup(); }
  });

  test('an absent catalog refuses rather than reporting an empty clean sweep', async () => {
    const repo = makeRepo({ files: guardFiles(), label: 'validate-nocatalog' });
    try {
      const result = await validate(repo);
      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /no catalog at/);
    } finally { repo.cleanup(); }
  });
});

describe('validate resolves against the working tree, not against HEAD', () => {
  test('an anchor broken by an uncommitted edit is reported (that is the failure it exists to catch)', async () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-dirty' });
    try {
      assert.equal((await validate(repo)).exitCode, 0);
      // The implementer edits the code under review; the anchor goes stale.
      write(repo.root, 'src/guard.mjs', `export function isAllowed(kind) {
  if (kind === 'ollama') return true;
  return kind === 'userDefined';
}
`);
      const { exitCode, report } = await validateJson(repo);
      assert.equal(exitCode, 4);
      assert.deepEqual(report.mutants[0].issues.map((i) => i.code), ['anchor-missing']);
      // And it did so without any clean-tree refusal: validate is not a gate.
      assert.equal(git(repo.root, ['status', '--porcelain']).trim().length > 0, true);
    } finally { repo.cleanup(); }
  });
});

describe('validate does not disturb the catalog contract', () => {
  test('a catalog that fails schema validation refuses before any resolution', async () => {
    const repo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-badschema' });
    try {
      writeFileSync(
        path.join(repo.root, '.mutation', 'mutants.json'),
        JSON.stringify({ mutants: [{ id: 'x', invariant: 'line 42', whyNotEquivalent: 'y', sites: [] }] }),
      );
      const result = await validate(repo);
      assert.equal(result.exitCode, 4);
      assert.match(result.stderr, /must name the invariant in prose/);
    } finally { repo.cleanup(); }
  });
});

describe('report-dir-unused', () => {
  // Invariant: a vitest harness whose commands never name the report dir is
  // flagged pre-flight -- as a warning, never a problem.
  test('warns, naming the exact flags, when a vitest command never mentions CODE_MUTANT_REPORT_DIR', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: {
        runner: 'vitest',
        baselineCommand: 'npx vitest run --reporter=json --outputFile=/dev/stdout',
        testCommand: 'npx vitest run --reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json" {tests}',
      },
      mutants: [GOOD],
      label: 'validate-report-dir',
    });
    try {
      const { exitCode, report } = await validateJson(repo);
      const issue = report.issues.find((i) => i.code === 'report-dir-unused');
      assert.ok(issue, JSON.stringify(report.issues));
      assert.equal(issue.severity, 'warning');
      assert.match(issue.detail, /"baselineCommand" never mentions it/);
      assert.ok(issue.detail.includes('--outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"'));
      assert.equal(exitCode, 0);
    } finally { repo.cleanup(); }
  });

  test('is silent when both commands name the dir, and for an adapter that reads no report', async () => {
    const flags = '--reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"';
    const vitestRepo = makeRepo({
      files: guardFiles(),
      config: { runner: 'vitest', baselineCommand: `npx vitest run ${flags}`, testCommand: `npx vitest run ${flags} {tests}` },
      mutants: [GOOD],
      label: 'validate-report-dir-ok',
    });
    const nodeRepo = makeRepo({ files: guardFiles(), mutants: [GOOD], label: 'validate-report-dir-node' });
    try {
      for (const repo of [vitestRepo, nodeRepo]) {
        const { report } = await validateJson(repo);
        assert.equal(report.issues.some((i) => i.code === 'report-dir-unused'), false);
      }
    } finally { vitestRepo.cleanup(); nodeRepo.cleanup(); }
  });
});
