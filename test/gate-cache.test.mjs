// CACHING THE BASELINE AND CANARY GATES ACROSS INVOCATIONS.
//
// `timings.gatesMs` is a fixed cost paid once per invocation and independent of
// mutant count: two full `baselineCommand` runs. Measured on code-conductor
// (`npm test` ~67s, 35-mutant catalog): ~135,000ms, 98.6% of a single-mutant
// invocation. Nothing about that work depends on which mutants are in the run,
// yet a repeat invocation against an unchanged tree re-measured both.
//
// EVERY CLAIM BELOW IS BIASED THE SAME WAY THE DESIGN IS. A false miss costs one
// re-measure; a false hit reports a green baseline against a tree that changed,
// which is the exact failure this harness exists to prevent. So most of these
// tests prove a MISS, and the ones that prove a hit carry a control that would
// have caught a cache which never hits at all.
//
// The instrument throughout is test/helpers/counting-command.mjs: how many times
// the WHOLE-SUITE command ran. Never a wall clock.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { harnessFingerprint } from '../lib/gate-cache.mjs';
import { git, guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';
import { childEnv, RUNNER, runCli } from './helpers/cli.mjs';
import { costConfig, costFiles, costMutants } from './helpers/cost-project.mjs';
import { waitFor } from './helpers/wait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COUNTING = path.join(HERE, 'helpers', 'counting-command.mjs');
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');
const PROJECT_ROOT = path.resolve(HERE, '..');

// `node --test` with no file arguments discovers the whole suite; with a scope
// it runs that scope. So an entry with an empty `args` in the log is one
// whole-suite run: the baseline gate, or one canary attempt that fired.
function countingConfig(overrides = {}) {
  return {
    baselineCommand: `node ${JSON.stringify(COUNTING)}`,
    testCommand: `node ${JSON.stringify(COUNTING)} {tests}`,
    runner: 'node-test',
    isolation: 'in-place',
    ...overrides,
  };
}

const MUTANT = {
  id: 'guard-ollama',
  invariant: 'isAllowed accepts the ollama backend',
  sites: [{
    file: 'src/guard.mjs',
    anchor: "if (kind === 'ollama') return true;",
    replacement: "if (kind === 'ollama') return false;",
  }],
  expectFail: ['test/guard.test.mjs::allows ollama'],
  expectPass: ['test/guard.test.mjs::rejects unknown'],
  whyNotEquivalent: 'refusing ollama is not accepting it',
};

function writeCatalog(repo, mutants) {
  mkdirSync(path.join(repo.root, '.mutation'), { recursive: true });
  writeFileSync(path.join(repo.root, '.mutation', 'mutants.json'), `${JSON.stringify({ mutants }, null, 2)}\n`);
}

function gateEntries(repo) {
  const dir = path.join(repo.root, '.mutation', 'gates');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

function readGateEntryFile(repo, file) {
  return JSON.parse(readFileSync(path.join(repo.root, '.mutation', 'gates', file), 'utf8'));
}

function journalEntries(repo) {
  const dir = path.join(repo.root, '.mutation', 'journal');
  return existsSync(dir) ? readdirSync(dir) : [];
}

// A counter scoped to ONE invocation: each call truncates the log, so a claim
// reads the commands that run 2 issued and not run 1's as well.
function makeCounter() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-count-'));
  const file = path.join(scratch, 'commands.jsonl');
  return {
    env: { CM_COUNT_LOG: file },
    reset() { writeFileSync(file, ''); },
    entries() {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    wholeSuite() { return this.entries().filter((e) => e.args.length === 0).length; },
    cleanup() { rmSync(scratch, { recursive: true, force: true }); },
  };
}

async function runJson(repo, args, env = {}) {
  const result = await runCli(args, { cwd: repo.root, env, timeoutMs: 300_000 });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* a usage error emits no report */ }
  return { ...result, report };
}

async function runInProcess(repo, mutants = [], overrides = {}) {
  const config = loadConfig({ repoRoot: repo.root });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  return execute({ config: { ...config, ...overrides }, adapter, mutants });
}

describe('gate cache', () => {
  test('G1: a second identical run serves both gates and measures neither', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-hit' });
    try {
      writeCatalog(repo, [MUTANT]);

      const first = await runJson(repo, ['run', '--all', '--json'], counter.env);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.equal(first.report.gateCache.status, 'miss');
      assert.equal(first.report.gates.baseline.fromCache, false);
      assert.ok(counter.wholeSuite() >= 1, 'the control: run 1 really did run the whole suite');

      counter.reset();
      const second = await runJson(repo, ['run', '--all', '--json'], counter.env);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.equal(second.report.gateCache.status, 'hit');
      assert.equal(second.report.gates.baseline.fromCache, true);
      assert.equal(second.report.gates.canary.fromCache, true);
      // THE DISCRIMINATOR: not "it was faster", but "the expensive command was
      // never issued". A cache that served a record while still measuring would
      // pass every field assertion above and fail this one.
      assert.equal(
        counter.wholeSuite(),
        0,
        `run 2 issued ${counter.wholeSuite()} whole-suite command(s): ${JSON.stringify(counter.entries())}`,
      );
      // Exactly 0, not merely less: the design commits to `durationMs: 0` on a
      // served record, so `gatesMs` is the sum of two zeroes.
      assert.equal(second.report.timings.gatesMs, 0);
      assert.ok(first.report.timings.gatesMs > 0, 'the control: run 1 paid a real gate cost');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('G2: a served record reports this run\'s cost and keeps the original as provenance', async () => {
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-provenance' });
    try {
      const first = await runJson(repo, ['baseline', '--json']);
      assert.equal(first.report.gates.baseline.measuredDurationMs, null, 'a measured record has no prior cost');

      const second = await runJson(repo, ['baseline', '--json']);
      const served = second.report.gates.baseline;
      // Both halves, because a mutant can break either one: replaying the old
      // duration as `durationMs` (which G1's `=== 0` catches) or dropping the
      // provenance (which only this catches).
      assert.equal(served.durationMs, 0);
      assert.equal(served.measuredDurationMs, first.report.gates.baseline.durationMs);
      assert.equal(second.report.gates.canary.measuredDurationMs, first.report.gates.canary.durationMs);
      // And the derivation identity T4 pins still holds over the served numbers.
      assert.equal(
        second.report.timings.gatesMs,
        served.durationMs + second.report.gates.canary.durationMs,
      );
    } finally { repo.cleanup(); }
  });

  test('G3: a committed source edit is a miss', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-committed' });
    try {
      const first = await runJson(repo, ['baseline', '--json'], counter.env);
      assert.equal(first.report.gateCache.status, 'miss');

      write(repo.root, 'src/guard.mjs', `${readFileSync(path.join(repo.root, 'src/guard.mjs'), 'utf8')}\nexport const extra = 1;\n`);
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'edit the source']);

      counter.reset();
      const second = await runJson(repo, ['baseline', '--json'], counter.env);
      assert.equal(second.report.gateCache.status, 'miss', 'changed source must not be served a stale gate');
      assert.equal(second.report.gates.baseline.fromCache, false);
      assert.ok(counter.wholeSuite() >= 1, 'the gates were re-measured');
      assert.equal(gateEntries(repo).length, 2, 'two trees, two entries');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('G4: an UNCOMMITTED edit to a tracked file is a miss', async () => {
    // The sharp one. A key built from `HEAD^{tree}` alone passes G3 and fails
    // here -- and this is the shape that matters, because the tree an operator
    // is proving is the one they are still editing.
    const counter = makeCounter();
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-worktree' });
    try {
      const first = await runJson(repo, ['baseline', '--json'], counter.env);
      assert.equal(first.report.gateCache.status, 'miss');
      assert.equal(gateEntries(repo).length, 1, 'the clean run seeded an entry to be tempted by');
      const sha = first.report.mutatedSha;

      appendFileSync(path.join(repo.root, 'src/guard.mjs'), '\nexport const uncommitted = 1;\n');

      counter.reset();
      const second = await runJson(repo, ['baseline', '--allow-dirty', '--json'], counter.env);
      assert.equal(second.report.mutatedSha, sha, 'the sha is UNCHANGED, or this proves nothing');
      assert.equal(second.report.gateCache.status, 'miss');
      assert.equal(second.report.gates.baseline.fromCache, false);
      assert.ok(counter.wholeSuite() >= 1, 'the gates were re-measured');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('G5: an untracked, not-gitignored file is a miss', async () => {
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-untracked' });
    try {
      const first = await runJson(repo, ['probe', '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;', '--expect-fail', 'test/guard.test.mjs::allows user-defined backends', '--json']);
      assert.equal(first.report.gateCache.status, 'miss');
      assert.equal(gateEntries(repo).length, 1);

      write(repo.root, 'src/newcomer.mjs', 'export const brandNew = 1;\n');

      const second = await runJson(repo, ['probe', '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;', '--expect-fail', 'test/guard.test.mjs::allows user-defined backends', '--json']);
      assert.equal(second.report.gateCache.status, 'miss', 'an untracked source file is part of what the suite runs');
      assert.equal(second.report.gates.canary.fromCache, false);
    } finally { repo.cleanup(); }
  });

  test('G6: each resolved command is in the key, testCommand included', async () => {
    // Driven through execute() rather than the CLI: config.json is tracked, so
    // editing it on disk would change the tree digest and this would pass for
    // the wrong reason. In process, the command is the ONLY variable that moves.
    const repo = makeRepo({
      files: costFiles({ modules: 2, workIterations: 0 }),
      config: costConfig(),
      label: 'gc-commands',
    });
    try {
      const mutants = costMutants(1);
      const first = await runInProcess(repo, mutants);
      assert.equal(first.gateCache.status, 'miss');

      // CONTROL: same config hits, so a miss below is about the command and not
      // about the cache being broken outright.
      const control = await runInProcess(repo, mutants);
      assert.equal(control.gateCache.status, 'hit', 'the control must hit, or G6 proves nothing');

      const otherBaseline = await runInProcess(repo, mutants, {
        baselineCommand: 'node --test --test-concurrency=1 test/m00.test.mjs test/m01.test.mjs',
      });
      assert.equal(otherBaseline.gateCache.status, 'miss', 'a different baselineCommand is a different measurement');

      // testCommand is never issued by either gate, and is in the key anyway:
      // the fingerprint is the harness's identity, not a hand-picked subset a
      // later edit can drift from.
      const otherTest = await runInProcess(repo, mutants, {
        testCommand: 'node --test --test-concurrency=1 {tests}  # narrowed differently',
      });
      assert.equal(otherTest.gateCache.status, 'miss', 'testCommand is part of the harness identity');

      assert.equal(gateEntries(repo).length, 3, 'three distinct configs, three entries');
    } finally { repo.cleanup(); }
  });

  test('G7: the harness\'s own source is in the key', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-harness-'));
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-harness' });
    try {
      // (a) the digest layer: one byte of one lib/*.mjs moves the fingerprint.
      const copy = path.join(scratch, 'harness');
      cpSync(PROJECT_ROOT, copy, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules', '.mutation'].includes(path.basename(src)),
      });
      const before = harnessFingerprint({ root: copy });
      assert.equal(before, harnessFingerprint({ root: copy }), 'the digest is stable for an unchanged tree');
      appendFileSync(path.join(copy, 'lib', 'measure.mjs'), '\n// one more byte\n');
      const after = harnessFingerprint({ root: copy });
      assert.notEqual(after, before, 'a changed harness source must change the fingerprint');

      // (b) the lookup layer: an entry filed under fingerprint A is not served
      // under fingerprint B. Simulated by rewriting the entry's key, which is
      // the only thing the lookup consults.
      const first = await runJson(repo, ['baseline', '--json']);
      assert.equal(first.report.gateCache.status, 'miss');
      const [file] = gateEntries(repo);
      const entry = readGateEntryFile(repo, file);
      const otherKey = `${entry.key.slice(0, 30)}${entry.key.slice(30) === 'ff' ? 'ee' : 'ff'}`;
      writeFileSync(
        path.join(repo.root, '.mutation', 'gates', `${otherKey}.json`),
        `${JSON.stringify({ ...entry, key: otherKey, keyInputs: { ...entry.keyInputs, harnessFingerprint: after } }, null, 2)}\n`,
      );
      const second = await runJson(repo, ['baseline', '--json']);
      assert.equal(second.report.gateCache.status, 'hit', 'the run must still find ITS key, not the other one');
      assert.equal(second.report.gateCache.key, entry.key);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('G8: a run killed mid-mutation writes no entry at all', async () => {
    // The crash window. The entry becomes visible only after the run proved it
    // left no trace, so a process that never got there records nothing -- which
    // is what makes the feature self-defending while card 2026-0044 (crash
    // residue) is still open. The journal assertion is what stops this passing
    // vacuously: it proves the run really did get past both gates first.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-gc-kill-'));
    const stateFile = path.join(scratch, 'invocations');
    const markerFile = path.join(scratch, 'running');
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig({ testCommand: `node ${JSON.stringify(STAGED)} {tests}` }),
      label: 'gc-killed',
    });
    try {
      writeCatalog(repo, costMutants(3));
      const child = spawn(process.execPath, [RUNNER, 'run', '--all', '--json'], {
        cwd: repo.root,
        env: childEnv({
          CM_FAKE_STATE: stateFile,
          CM_FAKE_BLOCK_WHEN_FILE_CONTAINS: 'src/m02.mjs:return 0;',
          CM_FAKE_MARKER: markerFile,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      const exited = new Promise((resolve) => child.on('close', resolve));

      await waitFor(() => existsSync(markerFile), { what: 'the third mutant to start blocking' });
      child.kill('SIGTERM');
      await exited;

      assert.ok(journalEntries(repo).length >= 1, 'the run must have got past both gates, or this is vacuous');
      assert.deepEqual(gateEntries(repo), [], 'no gate entry may exist before the run proved no trace');
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('G9: a tree carrying mutation residue never gets a hit', async () => {
    // Card 2026-0044's failure, simulated by hand: a SIGKILL the guard cannot
    // intercept leaves a mutation in the tree. `probe` only WARNS on a dirty
    // tree, so the clean-tree gate is not the defence here -- the tree digest is,
    // and it is over worktree bytes.
    const counter = makeCounter();
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-residue' });
    try {
      const probeArgs = ['probe', '--file', 'src/guard.mjs', '--anchor', "return kind === 'user-defined';", '--replace', 'return false;', '--expect-fail', 'test/guard.test.mjs::allows user-defined backends', '--json'];
      const first = await runJson(repo, probeArgs, counter.env);
      assert.equal(first.report.gateCache.status, 'miss');
      assert.equal(gateEntries(repo).length, 1, 'the clean tree seeded an entry');

      appendFileSync(path.join(repo.root, 'src/guard.mjs'), '\n// leftover mutation\n');

      counter.reset();
      const second = await runJson(repo, probeArgs, counter.env);
      assert.equal(second.report.gateCache.status, 'miss', 'residue must not be served a clean-tree gate');
      assert.equal(second.report.gates.baseline.fromCache, false);
      assert.ok(counter.wholeSuite() >= 1, 'the gates were re-measured against the residue-bearing tree');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('G10: --remeasure-gates re-measures AND refreshes the entry', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-bypass' });
    try {
      const first = await runJson(repo, ['baseline', '--json'], counter.env);
      assert.equal(first.report.gateCache.status, 'miss');
      const [file] = gateEntries(repo);
      const seeded = readGateEntryFile(repo, file).measuredAt;

      // CONTROL: without the flag the same tree hits, so the bypass below is
      // about the flag and not about the cache failing to work.
      const warm = await runJson(repo, ['baseline', '--json'], counter.env);
      assert.equal(warm.report.gateCache.status, 'hit', 'the control must hit, or G10 proves nothing');

      counter.reset();
      const bypassed = await runJson(repo, ['baseline', '--remeasure-gates', '--json'], counter.env);
      assert.equal(bypassed.report.gateCache.status, 'bypassed');
      assert.equal(bypassed.report.gates.baseline.fromCache, false);
      assert.equal(bypassed.report.gates.canary.fromCache, false);
      assert.ok(counter.wholeSuite() >= 1, 'the flag must actually re-measure');
      // The write half is load-bearing: it is the in-band correction path for an
      // entry whose key matches but whose un-keyed state (a fresh npm install,
      // an edited .env) moved. A flag that only skipped the read would leave the
      // stale entry in place to be served on the very next run.
      assert.equal(bypassed.report.gateCache.wrote, true);
      assert.equal(gateEntries(repo).length, 1, 'the same key was overwritten, not added beside');
      assert.notEqual(readGateEntryFile(repo, file).measuredAt, seeded, 'the entry must be refreshed');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('G11: a NOT-ESTABLISHED canary stays not-established when served', async () => {
    // The three gate states must survive the round trip. Promoting a served
    // `not-established` to `passed` would claim, at the reporting layer, a
    // property that was never established at the measuring layer -- which is the
    // whole class of error this project exists to catch.
    const repo = makeRepo({
      files: guardFiles(),
      config: {
        runner: 'exit-code',
        baselineCommand: 'node --check src/guard.mjs',
        testCommand: 'node --check src/guard.mjs',
        isolation: 'copy',
      },
      label: 'gc-not-established',
    });
    try {
      const first = await runJson(repo, ['baseline', '--json']);
      assert.equal(first.report.gates.canary.status, 'NOT-ESTABLISHED');
      assert.equal(first.report.gates.canary.outcome, 'not-established');

      const second = await runJson(repo, ['baseline', '--json']);
      assert.equal(second.report.gateCache.status, 'hit', 'the control: it was served, or nothing is proved');
      assert.equal(second.report.gates.canary.fromCache, true);
      assert.equal(second.report.gates.canary.status, 'NOT-ESTABLISHED');
      assert.equal(second.report.gates.canary.outcome, 'not-established');
      assert.equal(second.exitCode, first.exitCode);
    } finally { repo.cleanup(); }
  });

  test('G12: a FAILED gate is never cached', async () => {
    // The always-green liar: the baseline passes because the command lies, and
    // only the canary catches it. A cached failure would be bad on its own; a
    // cached failure that later read as a pass would be worse. Neither is
    // possible if nothing is written at all.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-gc-liar-'));
    const repo = makeRepo({
      files: guardFiles(),
      config: {
        baselineCommand: `CM_FAKE_ALWAYS_GREEN=1 CM_FAKE_STATE=${JSON.stringify(path.join(scratch, 's'))} node ${JSON.stringify(STAGED)}`,
        isolation: 'copy',
      },
      label: 'gc-liar',
    });
    try {
      const first = await runJson(repo, ['baseline', '--json']);
      assert.equal(first.report.gates.canary.outcome, 'failed');
      assert.equal(first.exitCode, 2);
      assert.deepEqual(gateEntries(repo), [], 'a failed canary must leave no entry');

      const second = await runJson(repo, ['baseline', '--json']);
      assert.equal(second.report.gateCache.status, 'miss');
      assert.equal(second.report.gates.canary.fromCache, false);
      assert.equal(second.report.gates.canary.outcome, 'failed');
      assert.deepEqual(gateEntries(repo), []);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('G13: a measurement made under --copy is not served to --in-place', async () => {
    // A copy is not a git repository (copyTree excludes .git), so a suite that
    // shells out to git is green in-place and red in a copy. Two different
    // measurements, two different keys.
    const repo = makeRepo({ files: guardFiles(), config: countingConfig({ isolation: 'copy' }), label: 'gc-isolation' });
    try {
      const first = await runJson(repo, ['baseline', '--copy', '--json']);
      assert.equal(first.report.isolation, 'copy');
      assert.equal(first.report.gateCache.status, 'miss');

      // CONTROL: the same mode hits.
      const sameMode = await runJson(repo, ['baseline', '--copy', '--json']);
      assert.equal(sameMode.report.gateCache.status, 'hit', 'the control must hit, or G13 proves nothing');

      const otherMode = await runJson(repo, ['baseline', '--in-place', '--json']);
      assert.equal(otherMode.report.isolation, 'in-place', 'the fixture must really have changed mode');
      assert.equal(otherMode.report.gateCache.status, 'miss');
      assert.equal(otherMode.report.gates.baseline.fromCache, false);
      assert.equal(gateEntries(repo).length, 2);
    } finally { repo.cleanup(); }
  });

  test('G14: an unignored .mutation/ skips the write instead of refusing', async () => {
    // `baseline` deliberately has no hard stop on an unignored `.mutation/`
    // today, and the cache must not hand it one. The leave-no-trace property is
    // preserved the other way: the write that would have left a visible
    // untracked file is the write that is skipped.
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), gitignore: null, label: 'gc-unignored' });
    try {
      const statusBefore = repo.status();
      const result = await runJson(repo, ['baseline', '--json']);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.report.gates.baseline.outcome, 'passed');
      assert.equal(result.report.gates.canary.status, 'KILLED');
      assert.equal(repo.status(), statusBefore, 'the run must leave the tree exactly as it found it');
      assert.deepEqual(gateEntries(repo), [], 'nothing may be written where it would be visible');
      assert.equal(result.report.gateCache.wrote, false);
      assert.match(result.report.gateCache.writeSkipped, /gitignored/, JSON.stringify(result.report.gateCache));
    } finally { repo.cleanup(); }
  });

  test('G15: the run states that the gates were served, on both output surfaces', async () => {
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-reporting' });
    try {
      const first = await runJson(repo, ['baseline', '--json']);
      assert.equal(first.report.gateCache.status, 'miss');

      const printed = await runCli(['baseline'], { cwd: repo.root, timeoutMs: 300_000 });
      assert.equal(printed.exitCode, 0, printed.stderr);
      // A served gate that read like a measured one is the single worst outcome
      // this feature could produce, so it is stated twice: once as a banner and
      // once on the gate line itself.
      assert.match(printed.stdout, /GATES FROM CACHE/);
      assert.match(printed.stdout, /served from cache, not measured here/);

      const json = await runJson(repo, ['baseline', '--json']);
      assert.equal(json.report.gateCache.status, 'hit');
      assert.notEqual(json.report.gateCache.measuredAt, null);
      assert.notEqual(json.report.gateCache.measuredSha, null);
    } finally { repo.cleanup(); }
  });

  test('G16: a resumed run on a warm cache does not claim the gates ran in full', async () => {
    // Two banners printed side by side, one of which used to assert "Every gate
    // above ran in full this invocation". Prose is exactly what a mutant will
    // not touch, so it is pinned here rather than left to a reader.
    const repo = makeRepo({
      files: costFiles({ modules: 2, workIterations: 0 }),
      config: costConfig(),
      label: 'gc-resumed-banner',
    });
    try {
      writeCatalog(repo, costMutants(1));
      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.exitCode, 0, first.stderr);

      const resumed = await runCli(['run', '--all', '--resume'], { cwd: repo.root, timeoutMs: 300_000 });
      assert.equal(resumed.exitCode, 0, resumed.stderr);
      assert.match(resumed.stdout, /RESUMED --/);
      assert.match(resumed.stdout, /GATES FROM CACHE/);
      assert.doesNotMatch(
        resumed.stdout,
        /Every gate above ran in full/,
        'the two banners must not contradict each other',
      );
    } finally { repo.cleanup(); }
  });

  test('G17: a malformed entry is a logged miss, not a throw', async () => {
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-malformed' });
    try {
      const first = await runJson(repo, ['baseline', '--json']);
      const [file] = gateEntries(repo);
      const entry = readGateEntryFile(repo, file);
      const abs = path.join(repo.root, '.mutation', 'gates', file);

      for (const [why, corrupt] of [
        ['not JSON', 'not json at all\n'],
        ['wrong schemaVersion', `${JSON.stringify({ ...entry, schemaVersion: 99 })}\n`],
        ['key mismatch', `${JSON.stringify({ ...entry, key: 'deadbeef'.repeat(4) })}\n`],
        ['missing a gate record', `${JSON.stringify({ ...entry, gates: { baseline: entry.gates.baseline } })}\n`],
      ]) {
        writeFileSync(abs, corrupt);
        const rerun = await runJson(repo, ['baseline', '--json']);
        assert.equal(rerun.exitCode, 0, `${why}: ${rerun.stderr}`);
        assert.equal(rerun.report.gateCache.status, 'miss', why);
        assert.equal(rerun.report.gates.baseline.fromCache, false, why);
        assert.match(rerun.stderr, /gate cache: ignoring/, why);
        // And it is REPLACED rather than left to be re-diagnosed every run.
        assert.equal(rerun.report.gateCache.wrote, true, why);
        assert.equal(readGateEntryFile(repo, file).key, first.report.gateCache.key, why);
      }
    } finally { repo.cleanup(); }
  });

  test('G18: --remeasure-gates is a usage error on the commands that run no gate', async () => {
    const repo = makeRepo({ files: guardFiles(), config: countingConfig(), label: 'gc-flag-scope' });
    try {
      writeCatalog(repo, [MUTANT]);
      for (const command of ['validate', 'candidates']) {
        const result = await runCli([command, '--remeasure-gates'], { cwd: repo.root, timeoutMs: 60_000 });
        assert.equal(result.exitCode, 4, `${command}: ${result.stderr}`);
        assert.match(result.stderr, /--remeasure-gates/, command);
      }
    } finally { repo.cleanup(); }
  });
});
