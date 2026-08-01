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
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { GateOutcome, execute } from '../lib/runner.mjs';
import { ExitCode, exitCodeFor, formatReport, toJson } from '../lib/report.mjs';
import { git, guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';

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
