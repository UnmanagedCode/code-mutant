// The third trust gate: mutation must run against committed state.
//
// Two independent refusals, both checked before baseline/canary:
//   - dirty-tree:        the worktree has uncommitted or untracked-not-ignored
//                        changes (run AND baseline; probe warns instead).
//   - empty-diff-vs-base: run only, and only a REAL refusal when a baseBranch is
//                        configured AND distinct from the branch HEAD is on --
//                        otherwise it is NOT-ESTABLISHED, never silently skipped
//                        and never conflated with PASSED.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { checkBaseDiffGate } from '../lib/gates.mjs';
import { gitCapture } from '../lib/git.mjs';
import { GateOutcome, execute } from '../lib/runner.mjs';
import { ExitCode, exitCodeFor, formatReport, toJson } from '../lib/report.mjs';
import { childEnv } from './helpers/cli.mjs';
import { GUARD_SOURCE, git, guardFiles, makeRepo, oversizeText, write } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MUTATE = path.join(HERE, '..', 'mutate.mjs');

const MUTANT = {
  id: 'm1',
  invariant: 'the user-defined-backend branch is load-bearing',
  sites: [{
    file: 'src/guard.mjs',
    anchor: "return kind === 'user-defined';",
    replacement: 'return false;',
  }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
  whyNotEquivalent: 'denies a backend the guard must admit',
};

async function run(repo, mutants, overrides = {}, executeOpts = {}) {
  const config = loadConfig({ repoRoot: repo.root, overrides });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  return execute({ config, adapter, mutants, ...executeOpts });
}

describe('dirty-tree gate', () => {
  test('refuses run on an uncommitted change, before baseline ever runs', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, mutants: [MUTANT], label: 'dirty-run' });
    try {
      appendFileSync(`${repo.root}/src/guard.mjs`, '\n// uncommitted\n');
      const report = await run(repo, [MUTANT]);
      assert.equal(report.gates.cleanTree.outcome, GateOutcome.FAILED);
      assert.equal(report.gates.cleanTree.code, 'dirty-tree');
      assert.equal(report.gates.baseline, undefined, 'baseline must not even be attempted');
      assert.deepEqual(report.results, []);
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  test('a gitignored .mutation/ does not trip the check', async () => {
    // makeRepo writes .mutation/mutants.json (gitignored) whenever `mutants` is
    // given -- if that tripped the check, every other test in this suite that
    // passes mutants would spuriously refuse.
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, mutants: [MUTANT], label: 'gitignored' });
    try {
      const report = await run(repo, [MUTANT]);
      assert.equal(report.gates.cleanTree.outcome, GateOutcome.PASSED);
      assert.equal(report.gates.cleanTree.dirty, false);
    } finally { repo.cleanup(); }
  });

  test('--allow-dirty proceeds, and labels every verdict non-reproducible in both matrix and json', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, mutants: [MUTANT], label: 'allow-dirty' });
    try {
      appendFileSync(`${repo.root}/src/guard.mjs`, '\n// uncommitted\n');
      const report = await run(repo, [MUTANT], {}, { allowDirty: true });

      assert.equal(report.gates.cleanTree.outcome, GateOutcome.PASSED);
      assert.equal(report.gates.cleanTree.allowedDirty, true);
      assert.equal(report.reproducible, false);
      assert.equal(report.results[0].reproducible, false);
      assert.notEqual(report.results[0].verdict, undefined, 'the run must still produce a verdict');

      assert.match(formatReport(report), /NO \(dirty\)/, 'the matrix must label the row, not just the gate');
      assert.equal(toJson(report).reproducible, false);
      assert.equal(toJson(report).results[0].reproducible, false);
    } finally { repo.cleanup(); }
  });

  test('baseline is refused on a dirty tree too, not just run', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, label: 'dirty-baseline' });
    try {
      appendFileSync(`${repo.root}/src/guard.mjs`, '\n// uncommitted\n');
      const report = await run(repo, []);
      assert.equal(report.gates.cleanTree.outcome, GateOutcome.FAILED);
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  test('probe warns on a dirty tree but proceeds -- it is the ad-hoc escape hatch', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, label: 'probe-dirty' });
    try {
      appendFileSync(`${repo.root}/src/guard.mjs`, '\n// uncommitted\n');
      const result = spawnSync(process.execPath, [
        MUTATE, 'probe',
        '--file', 'src/guard.mjs',
        '--anchor', "return kind === 'user-defined';",
        '--replace', 'return false;',
        '--expect-fail', 'test/guard.test.mjs::allows user-defined backends',
      ], { cwd: repo.root, encoding: 'utf8' });

      assert.match(result.stderr, /worktree has uncommitted or untracked changes/);
      assert.match(result.stderr, /proceeds anyway/);
      // Not refused: probe reached a real verdict rather than exiting on GATE_FAILED.
      assert.notEqual(result.status, ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });
});

describe('empty-diff-vs-base gate (run only)', () => {
  function repoWithBase(label) {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, mutants: [MUTANT], label });
    return repo;
  }

  test('no baseBranch configured: NOT-ESTABLISHED, and the run still proceeds', async () => {
    const repo = repoWithBase('base-none');
    try {
      const report = await run(repo, [MUTANT], {}, { checkBaseDiff: true, base: null });
      assert.equal(report.gates.baseDiff.outcome, GateOutcome.NOT_ESTABLISHED);
      assert.notEqual(report.results.length, 0, 'a gate that did not run must not block the proof');
    } finally { repo.cleanup(); }
  });

  test('baseBranch equal to the current branch: NOT-ESTABLISHED, never a false refusal', async () => {
    const repo = repoWithBase('base-same');
    try {
      const currentBranch = git(repo.root, ['branch', '--show-current']).trim();
      const report = await run(repo, [MUTANT], {}, { checkBaseDiff: true, base: currentBranch });
      assert.equal(report.gates.baseDiff.outcome, GateOutcome.NOT_ESTABLISHED);
      assert.match(report.gates.baseDiff.detail, /branch HEAD is already on/);
      assert.notEqual(report.results.length, 0, 'comparing a branch to itself must never refuse the run');
    } finally { repo.cleanup(); }
  });

  test('baseBranch distinct with no committed work since it: hard refusal', async () => {
    const repo = repoWithBase('base-empty-diff');
    try {
      // A branch pointer at the current tip, with nothing committed since --
      // exactly "implementer committed nothing" from the card's rationale.
      git(repo.root, ['branch', 'upstream-base']);
      const report = await run(repo, [MUTANT], {}, { checkBaseDiff: true, base: 'upstream-base' });
      assert.equal(report.gates.baseDiff.outcome, GateOutcome.FAILED);
      assert.equal(report.gates.baseDiff.code, 'empty-diff-vs-base');
      assert.deepEqual(report.results, []);
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  test('baseBranch distinct with committed work since it: passes and the run proceeds', async () => {
    const repo = repoWithBase('base-has-diff');
    try {
      git(repo.root, ['branch', 'upstream-base']);
      write(repo.root, 'src/extra.mjs', 'export const extra = 1;\n');
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'committed work on top of the base']);

      const report = await run(repo, [MUTANT], {}, { checkBaseDiff: true, base: 'upstream-base' });
      assert.equal(report.gates.baseDiff.outcome, GateOutcome.PASSED);
      assert.notEqual(report.results.length, 0);
    } finally { repo.cleanup(); }
  });

  test('an unresolvable --base is a structured gate failure, not a process crash', async () => {
    const repo = repoWithBase('base-unresolvable');
    try {
      const report = await run(repo, [MUTANT], {}, { checkBaseDiff: true, base: 'no-such-branch-at-all' });
      assert.equal(report.gates.baseDiff.outcome, GateOutcome.FAILED);
      assert.equal(report.gates.baseDiff.code, 'base-unresolvable');
      assert.deepEqual(report.results, []);
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  // A base a few hundred commits behind is ordinary, and its diff is megabytes:
  // reading the whole thing to answer "is it empty?" is what turned distance
  // into `spawnSync git ENOBUFS`, exit 4, and no result file at all.
  function repoAheadOfBase(label, { fileBytes = 1_500_000 } = {}) {
    const repo = repoWithBase(label);
    git(repo.root, ['branch', 'upstream-base']);
    write(repo.root, 'docs/generated.txt', oversizeText(fileBytes));
    git(repo.root, ['add', '-A']);
    git(repo.root, ['commit', '-qm', 'a large committed change']);
    return repo;
  }

  test('a base whose diff exceeds 1 MiB passes the gate instead of throwing', () => {
    const repo = repoAheadOfBase('base-huge-diff');
    try {
      // The premise, measured rather than assumed: this diff really is past the
      // execFileSync default the crash came from.
      assert.ok(
        gitCapture(repo.root, ['diff', 'upstream-base']).length > 1024 * 1024,
        'the fixture diff must exceed 1 MiB or this test proves nothing',
      );

      const gate = checkBaseDiffGate(repo.root, 'upstream-base');
      assert.equal(gate.outcome, GateOutcome.PASSED);
      assert.equal(gate.code, null);
    } finally { repo.cleanup(); }
  });

  test('a stat-only touch on an identical file does not read as committed work', () => {
    const repo = repoWithBase('base-stat-touch');
    try {
      git(repo.root, ['branch', 'upstream-base']);
      // Same bytes, new mtime: the emptiness answer must come from comparing
      // CONTENT, so stat churn alone can never manufacture "there is work here".
      const stamp = new Date(Date.now() + 5_000);
      utimesSync(path.join(repo.root, 'src/guard.mjs'), stamp, stamp);

      const gate = checkBaseDiffGate(repo.root, 'upstream-base');
      assert.equal(gate.outcome, GateOutcome.FAILED);
      assert.equal(gate.code, 'empty-diff-vs-base');
      assert.equal(gate.distance, null);
    } finally { repo.cleanup(); }
  });

  test('a committed change with no changed lines still reads as committed work', () => {
    const repo = repoWithBase('base-mode-only');
    try {
      git(repo.root, ['branch', 'upstream-base']);
      chmodSync(path.join(repo.root, 'src/guard.mjs'), 0o755);
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'mode only']);

      // A mode change moves no lines: emptiness must be read from whether git
      // reported a change at all, never from the insertion/deletion counts, or
      // this run would be refused for having "nothing to mutate".
      const gate = checkBaseDiffGate(repo.root, 'upstream-base');
      assert.equal(gate.outcome, GateOutcome.PASSED);
      assert.deepEqual(
        { insertions: gate.distance.insertions, deletions: gate.distance.deletions },
        { insertions: 0, deletions: 0 },
      );
    } finally { repo.cleanup(); }
  });

  test('the gate record names the base distance', () => {
    const repo = repoAheadOfBase('base-distance', { fileBytes: 4_000 });
    try {
      // A second file, edited rather than added, so shortstat renders "files
      // changed" and "insertions(+)" plural beside a singular "deletion(-)" --
      // the three word forms the record has to read back out of one line.
      write(repo.root, 'src/guard.mjs', GUARD_SOURCE.replace("return true;", 'return true; // touched'));
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'a second, edited file']);

      const gate = checkBaseDiffGate(repo.root, 'upstream-base');
      const lines = oversizeText(4_000).split('\n').length - 1;

      assert.deepEqual(gate.distance, {
        commitsAhead: 2, filesChanged: 2, insertions: lines + 1, deletions: 1,
      });
      assert.match(gate.detail, /2 commit\(s\) ahead/);
    } finally { repo.cleanup(); }
  });

  test('a committed binary change reads as committed work', () => {
    const repo = repoWithBase('base-binary');
    try {
      // Binary content carries no lines for shortstat to count, so a gate that
      // decided emptiness from the line counts would refuse a real change here.
      write(repo.root, 'assets/blob.bin', Buffer.from([0, 1, 2, 3, 0, 255, 7, 0]));
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'a binary asset']);
      git(repo.root, ['branch', 'upstream-base', 'HEAD~1']);
      write(repo.root, 'assets/blob.bin', Buffer.from([0, 9, 9, 9, 0, 1, 1, 0, 4]));
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'the binary asset changes']);

      const gate = checkBaseDiffGate(repo.root, 'upstream-base');
      assert.equal(gate.outcome, GateOutcome.PASSED);
      assert.equal(gate.distance.filesChanged, 1);
    } finally { repo.cleanup(); }
  });

  test('an unreadable base diff is a structured gate failure, not a process exit', () => {
    const repo = repoAheadOfBase('base-unreadable', { fileBytes: 4_000 });
    try {
      // A capture bound nothing can fit under, so the gate meets a real read
      // failure rather than a simulated one.
      const gate = checkBaseDiffGate(repo.root, 'upstream-base', { maxBuffer: 1 });

      assert.equal(gate.outcome, GateOutcome.FAILED);
      assert.equal(gate.code, 'base-diff-unreadable');
      assert.match(gate.detail, /git diff --shortstat/, 'the record names the argv that could not be read');
      assert.equal(exitCodeFor({ gates: { baseDiff: gate }, results: [] }), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  test('a run against a far-behind base always writes a result file', () => {
    const repo = repoAheadOfBase('base-run-e2e');
    try {
      const result = spawnSync(process.execPath, [
        MUTATE, 'run', '--id', 'm1', '--base', 'upstream-base', '--copy',
      ], { cwd: repo.root, encoding: 'utf8', env: childEnv() });

      assert.notEqual(result.status, ExitCode.USAGE, `exit ${result.status}: ${result.stderr}`);

      // The matrix a human reads, not just the field a consumer parses: which
      // base this invocation resolved, and how far behind it is, is what makes a
      // mismatch with `candidates`' own base visible instead of silent.
      assert.match(
        result.stdout,
        /base-diff\s+PASSED\s+vs upstream-base\s+upstream-base \(merge-base [0-9a-f]{12}, 1 commit\(s\) ahead, 1 file\(s\), \+\d+\/-0\)/,
      );

      const resultsDir = path.join(repo.root, '.mutation', 'results');
      assert.ok(existsSync(resultsDir), `no results directory: ${result.stderr}`);
      const [file] = readdirSync(resultsDir);
      const report = JSON.parse(readFileSync(path.join(resultsDir, file), 'utf8'));

      assert.equal(report.gates.baseDiff.outcome, GateOutcome.PASSED);
      assert.equal(report.gates.baseDiff.distance.commitsAhead, 1);
    } finally { repo.cleanup(); }
  });
});

describe('mutated sha', () => {
  test('the report records HEAD so a survivor is re-runnable later', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, mutants: [MUTANT], label: 'sha' });
    try {
      const report = await run(repo, [MUTANT]);
      const headSha = git(repo.root, ['rev-parse', 'HEAD']).trim();
      assert.equal(report.mutatedSha, headSha);
      assert.equal(report.reproducible, true);
    } finally { repo.cleanup(); }
  });
});
