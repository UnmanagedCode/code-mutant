// RESUMING AN INTERRUPTED RUN.
//
// `run` wrote its results file exactly once, after execute() returned, so an
// interrupt lost 100% of the work no matter how many mutants had been graded.
// Measured (card 2026-0036 Part 1, S3): twelve learn mutants cost 25s of measured
// commands against 4s of gates, so an interrupt after ten threw away ~80% of a run.
//
// What resume must NOT do is as load-bearing as what it does: it never skips a
// gate, never assumes tree state, and never reuses a verdict earned against
// different code or a different config. Each of those is a test below.
//
// The real CLI is driven as a child process throughout, because the exit code and
// the advisory on stderr are part of the contract.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { Verdict } from '../lib/classify.mjs';
import { git, makeRepo, write } from './helpers/tmp-repo.mjs';
import { childEnv, RUNNER, runCli } from './helpers/cli.mjs';
import { costConfig, costFiles, costMutants } from './helpers/cost-project.mjs';
import { waitFor } from './helpers/wait.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');

function writeCatalog(repo, mutants) {
  mkdirSync(path.join(repo.root, '.mutation'), { recursive: true });
  writeFileSync(path.join(repo.root, '.mutation', 'mutants.json'), `${JSON.stringify({ mutants }, null, 2)}\n`);
}

function journalFiles(repo) {
  const dir = path.join(repo.root, '.mutation', 'journal');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function journalLines(repo) {
  const files = journalFiles(repo);
  if (!files.length) return [];
  return readFileSync(path.join(repo.root, '.mutation', 'journal', files[0]), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function runJson(repo, args, env = {}) {
  const result = await runCli(args, { cwd: repo.root, env, timeoutMs: 300_000 });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* a usage error emits no report */ }
  return { ...result, report };
}

describe('resuming an interrupted run', () => {
  test('11: an interrupted run resumes from completed verdicts instead of restarting', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-resume-'));
    const stateFile = path.join(scratch, 'invocations');
    const markerFile = path.join(scratch, 'running');
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig({ testCommand: `node ${JSON.stringify(STAGED)} {tests}` }),
      label: 'resume-interrupt',
    });
    try {
      const mutants = costMutants(3);
      writeCatalog(repo, mutants);

      // The block point is CONTENT-ADDRESSED, not ordinal: the canary's attempt
      // count is variable (claim 15 exercises exactly that variability), so an
      // ordinal would shift and block the wrong command. Mutant 3's replacement
      // in src/m02.mjs is the fact that distinguishes its own run -- its narrow
      // baseline runs against the unmutated file and returns green, and the canary
      // injects into TEST files so it never matches.
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
      // Two verdicts are journalled before the third blocks; wait for the file
      // rather than assuming the append has landed.
      await waitFor(
        () => journalLines(repo).filter((l) => l.kind === 'result').length === 2,
        { what: 'two journalled verdicts' },
      );
      child.kill('SIGTERM');
      await exited;

      const lines = journalLines(repo);
      assert.equal(lines[0].kind, 'header');
      assert.equal(lines.filter((l) => l.kind === 'result').length, 2, 'exactly the completed mutants');

      const before = Number(readFileSync(stateFile, 'utf8').trim());

      // Re-run with --resume and no blocking.
      const second = await runJson(repo, ['run', '--all', '--resume', '--json'], { CM_FAKE_STATE: stateFile });
      const report = second.report;

      assert.equal(report.resumed.reused, 2, JSON.stringify(report.resumed));
      assert.equal(report.resumed.ran, 1);
      assert.equal(report.results.length, 3);
      assert.deepEqual(
        report.results.map((r) => r.fromJournal),
        [true, true, false],
        'catalog order preserved, and only the interrupted mutant re-measured',
      );

      // THE LOAD-BEARING ASSERTION, and the reason this counter is the right
      // instrument: the fake command is `testCommand` only, while the baseline and
      // canary gates run `baselineCommand`. So the counter sees EXACTLY the
      // per-mutant commands and none of the gate traffic -- which also makes it
      // independent of the canary's variable attempt count.
      //
      // Three mutants, one still to measure: ONE narrow baseline + ONE mutant run.
      // If the resume filter ran after Phase A's narrow-baseline loop instead of
      // before it, this would be 4 -- the verdicts would be reused and every scope
      // re-paid anyway, which is the expensive half and the whole of AC4.
      const after = Number(readFileSync(stateFile, 'utf8').trim());
      assert.equal(
        after - before,
        2,
        `the fake command ran ${after - before} times, expected 2 (one narrow baseline + one mutant `
        + 'run) -- a resumed mutant must cost neither',
      );
      // The gates did run, and in full: resume never skips one.
      assert.equal(report.gates.baseline.outcome, 'passed');
      assert.equal(report.gates.canary.status, 'KILLED');
      // And the same fact from the other side: one scope measured, not three.
      assert.equal(report.narrowBaselines.length, 1);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('12: resume never bypasses the clean-tree gate', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-dirty',
    });
    try {
      writeCatalog(repo, costMutants(2));
      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.ok(journalFiles(repo).length, 'the first run must journal something to resume from');

      // A SIGKILL the guard cannot intercept can leave a mutation in the tree.
      // Simulated by hand. The journal key still MATCHES (HEAD is unchanged), so
      // the clean-tree gate is the only thing between resume and a poisoned
      // measurement.
      appendFileSync(path.join(repo.root, 'src/m00.mjs'), '\n// leftover mutation\n');

      const second = await runJson(repo, ['run', '--all', '--resume', '--json']);
      assert.equal(second.exitCode, 2, second.stderr);
      assert.equal(second.report.gates.cleanTree.outcome, 'failed');
      assert.deepEqual(second.report.results, []);
      assert.equal(second.report.resumed, null, 'the run stopped before the resume filter was reached');
    } finally { repo.cleanup(); }
  });

  test('13: a verdict earned against different code is never reused', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-sha',
    });
    try {
      writeCatalog(repo, costMutants(2));
      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.exitCode, 0, first.stderr);
      const shaA = first.report.mutatedSha;

      // Commit an unrelated change: same catalog, same config, different sha.
      write(repo.root, 'src/other.mjs', 'export const unrelated = 1;\n');
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'unrelated change']);

      const second = await runJson(repo, ['run', '--all', '--resume', '--json']);
      assert.notEqual(second.report.mutatedSha, shaA);
      assert.equal(second.report.resumed.reused, 0);
      assert.equal(second.report.resumed.ran, 2);
      for (const r of second.report.results) assert.equal(r.fromJournal, false);
      // A different sha is a different key, so it is a different journal file.
      assert.equal(journalFiles(repo).length, 2);
    } finally { repo.cleanup(); }
  });

  test('14: a non-reproducible verdict never becomes a resumable one', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-nonrepro',
    });
    try {
      writeCatalog(repo, costMutants(1));
      // Dirty the tree, then proceed under --allow-dirty.
      appendFileSync(path.join(repo.root, 'src/m03.mjs'), '\n// uncommitted\n');

      const dirty = await runJson(repo, ['run', '--all', '--allow-dirty', '--json']);
      assert.equal(dirty.report.reproducible, false);
      assert.deepEqual(journalFiles(repo), [], 'a --allow-dirty run must journal nothing');

      // And the two flags together are a usage error, not a silent no-op.
      const both = await runJson(repo, ['run', '--all', '--resume', '--allow-dirty', '--json']);
      assert.equal(both.exitCode, 4);
      assert.match(both.stderr, /--resume/);
      assert.match(both.stderr, /--allow-dirty/);
    } finally { repo.cleanup(); }
  });

  test('15: a re-run does not re-pay failed canary attempts', async () => {
    // S5-shaped: baselineCommand is scoped to the LAST module, so the earlier
    // candidates the gate prefers sit outside its scope and their attempts are
    // recorded rather than fired.
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig({ baselineCommand: 'node --test --test-concurrency=1 test/m03.test.mjs' }),
      label: 'resume-canary',
    });
    try {
      writeCatalog(repo, costMutants(1));

      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.ok(first.report.gates.canary.attempts.length >= 1, JSON.stringify(first.report.gates.canary));
      assert.equal(first.report.gates.canary.target, 'test/m03.test.mjs');

      // Run 2 prepends the journalled target to the CANDIDATE list. The canary
      // still runs in full and must still fire -- no gate verdict is ever cached.
      const second = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(second.report.gates.canary.attempts.length, 0, JSON.stringify(second.report.gates.canary));
      assert.equal(second.report.gates.canary.target, 'test/m03.test.mjs');
      assert.equal(second.report.gates.canary.status, 'KILLED');
    } finally { repo.cleanup(); }
  });

  test('16: marking a survivor waived does not force a re-run', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-waived',
    });
    try {
      // A mutation nothing asserts against -- a survivor.
      const survivor = {
        id: 'survivor',
        invariant: 'the label export is pinned',
        sites: [{ file: 'src/m00.mjs', anchor: "export const label = 'm00';", replacement: "export const label = 'm00'; export const spare = 2;" }],
        expectFail: ['test/m00.test.mjs::m00 limit is pinned'],
        expectPass: [],
        whyNotEquivalent: 'adds an export nothing asserts on',
      };
      writeCatalog(repo, [survivor]);

      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.report.results[0].verdict, Verdict.SURVIVED, first.report.results[0].detail);
      assert.equal(first.exitCode, 1, 'an un-waived survivor is a blocking finding');

      // The reviewer records the conductor's decision. `waived` is deliberately
      // outside the fingerprint -- it is a decision, not a change to what is
      // measured -- so this must not cost a re-run.
      writeCatalog(repo, [{ ...survivor, waived: { reason: 'accepted risk, tracked separately' } }]);

      const second = await runJson(repo, ['run', '--all', '--resume', '--json']);
      assert.equal(second.report.resumed.reused, 1, JSON.stringify(second.report.resumed));
      assert.equal(second.report.results[0].fromJournal, true);
      // Reused AND re-read: the waiver comes from the current catalog, not the
      // journal, so it takes effect on a reused verdict.
      assert.equal(second.report.summary.waivedSurvivors, 1);
      assert.equal(second.report.summary.survivors, 0);
      assert.equal(second.exitCode, 0, 'a waived survivor does not block');
    } finally { repo.cleanup(); }
  });

  test('18: a verdict earned under one --jobs value is never reused under another', async () => {
    // Deliberate, per the plan: reusing a jobs=4 verdict inside a jobs=1 re-run
    // would hide precisely the concurrent-suite hazard the README tells a reader
    // to check for -- a fixed port, a shared temp dir, a shared DB. The whole
    // point of re-running serially is to get a verdict that did NOT come from a
    // concurrent run, so handing back the concurrent one defeats the exercise.
    //
    // Copy isolation throughout, because jobs > 1 is clamped to 1 in-place, which
    // would make the two runs share a key legitimately and the test vacuous.
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-jobs',
    });
    try {
      writeCatalog(repo, costMutants(2));

      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.equal(first.report.jobs, 1);

      // CONTROL, in the same jobs value: reuse does happen here, so a failure
      // below is about `jobs` and not about resume being broken outright.
      const sameJobs = await runJson(repo, ['run', '--all', '--resume', '--json']);
      assert.equal(sameJobs.report.jobs, 1);
      assert.equal(sameJobs.report.resumed.reused, 2, 'the control must reuse, or claim 18 proves nothing');

      // THE INVARIANT: a different jobs value is a different key.
      const otherJobs = await runJson(repo, ['run', '--all', '--resume', '--jobs', '2', '--json']);
      assert.equal(otherJobs.report.jobs, 2, 'the fixture must actually have changed jobs');
      assert.equal(otherJobs.report.resumed.reused, 0, 'a jobs=1 verdict must not be reused at jobs=2');
      assert.equal(otherJobs.report.resumed.ran, 2);
      for (const r of otherJobs.report.results) assert.equal(r.fromJournal, false);
      // Different key means a separate journal file, not an appended one.
      assert.equal(journalFiles(repo).length, 2);
    } finally { repo.cleanup(); }
  });

  test('19: retuning the hang deadline invalidates verdicts earned under the old one', async () => {
    // A verdict produced under one deadline says nothing under another: the point
    // of retuning is to change what gets killed, so resurrecting a TIMEOUT the old
    // deadline produced would silently defeat the retune. And tuning the deadline
    // between an interrupted run and its resume is the EXPECTED case -- it is what
    // this feature is for -- not an exotic one.
    //
    // Driven through execute() rather than the CLI on purpose: config.json is
    // committed, so editing it on disk would either dirty the tree (failing the
    // clean-tree gate) or need a commit (changing mutatedSha, which invalidates
    // the key on its own and would pass this test for the wrong reason). In
    // process, `hang` is the ONLY variable that moves.
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-hang-key',
    });
    try {
      const mutants = costMutants(2);
      const config = loadConfig({ repoRoot: repo.root });
      const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
      const run = (overrides, resume) => execute({
        config: { ...config, ...overrides }, adapter, mutants, journalling: true, resume,
      });

      const first = await run({}, false);
      assert.equal(first.results.length, 2);
      const sha = first.mutatedSha;

      // CONTROL: same config, so the verdicts come back.
      const same = await run({}, true);
      assert.equal(same.resumed.reused, 2, 'the control must reuse, or claim 19 proves nothing');

      // THE INVARIANT: floorMs halved is a real change to the derived deadline
      // (these scopes are fast, so the floor is what binds -- see the README's
      // `hang` row), and no verdict earned under the old floor is reused.
      const retuned = await run({ hang: { factor: config.hang.factor, floorMs: 5000 } }, true);
      assert.equal(retuned.mutatedSha, sha, 'the sha must be unchanged, or this proves nothing');
      assert.equal(retuned.resumed.reused, 0, 'a verdict earned under the old deadline must not be reused');
      assert.equal(retuned.resumed.ran, 2);
      for (const r of retuned.results) assert.equal(r.fromJournal, false);
      assert.equal(journalFiles(repo).length, 2, 'a retune writes its own journal, it does not append');
    } finally { repo.cleanup(); }
  });

  test('17: a resumable journal announces itself when --resume was not passed', async () => {
    const repo = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-advisory',
    });
    const fresh = makeRepo({
      files: costFiles({ modules: 4, workIterations: 0 }),
      config: costConfig(),
      label: 'resume-advisory-fresh',
    });
    try {
      writeCatalog(repo, costMutants(2));
      writeCatalog(fresh, costMutants(2));

      // NEGATIVE direction first: no journal for this key.
      const none = await runJson(fresh, ['run', '--all', '--json']);
      assert.equal(none.report.resumable, null);
      assert.doesNotMatch(none.stderr, /--resume/, 'nothing to announce means nothing announced');
      const cleanExit = none.exitCode;

      // Seed a journal, then run the SAME command again.
      const first = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.equal(first.report.resumable, null, 'the run that created the journal has nothing to announce');

      const positive = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(positive.report.resumable.available, 2, JSON.stringify(positive.report.resumable));
      assert.equal(positive.report.resumable.key, journalFiles(repo)[0].replace('.jsonl', ''));
      assert.match(positive.stderr, /--resume/);
      // ADVISORY, not a gate: same exit code as the identical run with no journal.
      assert.equal(positive.exitCode, cleanExit);

      // And once the flag is present the advisory is not needed.
      const resumed = await runJson(repo, ['run', '--all', '--resume', '--json']);
      assert.equal(resumed.report.resumable, null);
      assert.doesNotMatch(resumed.stderr, /Re-run with --resume/);
    } finally { repo.cleanup(); fresh.cleanup(); }
  });
});
