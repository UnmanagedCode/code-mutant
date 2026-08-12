// `run --all --learn`: the batch form of discovery. No `--from-file`, no driver
// script -- the existing catalog and `run`'s existing selection/gates/results-file
// plumbing are the whole feature; this file pins that a draft catalog (every entry
// with `expectFail: []`) runs in one invocation instead of needing one probe per
// entry, and that graded `run` still refuses the same catalog outright.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ExitCode } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

const DRAFT_MUTANTS = [
  {
    id: 'm1',
    invariant: 'draft: the ollama branch',
    whyNotEquivalent: 'flips the ollama branch to always deny',
    sites: [{ file: 'src/guard.mjs', anchor: "if (kind === 'ollama') return true;", replacement: "if (kind === 'ollama') return false;" }],
    expectFail: [],
  },
  {
    id: 'm2',
    invariant: 'draft: the user-defined branch',
    whyNotEquivalent: 'flips the user-defined branch to always deny',
    sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
    expectFail: [],
  },
  {
    id: 'm3',
    invariant: 'draft: a behavior-preserving edit -- nothing should cover this',
    whyNotEquivalent: 'textually differs from the anchor, so the runner accepts it, but the guard'
      + " does not observe kind === 'user-defined'",
    sites: [{ file: 'src/guard.mjs', anchor: 'export function isAllowed(kind) {', replacement: 'export function isAllowed(kind) { // noop' }],
    expectFail: [],
  },
];

// baselineCommand deliberately differs from what substituteInto(testCommand, '')
// trims to ('node --test'): every draft mutant here has expectFail: [], so all
// three hit the learn no-refs fallback, and a fallback that wrongly re-derived
// the command from testCommand rather than using baselineCommand verbatim would
// otherwise produce a byte-identical string -- a survivor the memo test below is
// written to catch.
const LEARN_BASELINE_COMMAND = 'node --test test/*.test.mjs';

function draftRepo(label) {
  return makeRepo({
    files: guardFiles(), mutants: DRAFT_MUTANTS, config: { baselineCommand: LEARN_BASELINE_COMMAND }, label,
  });
}

async function runJson(repo, args) {
  const result = await runCli(['run', ...args, '--json'], { cwd: repo.root });
  return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
}

describe('run --all --learn', () => {
  test('one invocation reports all 3 draft mutants, each LEARNED or SURVIVED', async () => {
    const repo = draftRepo('run-learn-batch');
    try {
      const { exitCode, report } = await runJson(repo, ['--all', '--learn']);
      assert.equal(report.learn, true);
      assert.equal(report.results.length, 3);
      for (const r of report.results) {
        assert.ok(['LEARNED', 'SURVIVED'].includes(r.verdict), `unexpected verdict ${r.verdict} for ${r.id}`);
      }
      const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
      assert.equal(byId.m1.verdict, 'LEARNED');
      assert.equal(byId.m2.verdict, 'LEARNED');
      assert.equal(byId.m3.verdict, 'SURVIVED');
      // A learn SURVIVED is still the finding "nothing here covers this" -- exit 1, same as graded.
      assert.equal(exitCode, ExitCode.SURVIVORS);
    } finally { repo.cleanup(); }
  });

  test('all 3 share the baselineCommand scope -- one narrow baseline measurement, not three', async () => {
    const repo = draftRepo('run-learn-memo');
    try {
      const { stderr, report } = await runJson(repo, ['--all', '--learn']);
      assert.match(stderr, /narrow baselines: 1 distinct scope\(s\)/);
      for (const r of report.results) {
        assert.equal(r.narrowing.command, LEARN_BASELINE_COMMAND);
      }
    } finally { repo.cleanup(); }
  });

  test('graded run on the same draft catalog still refuses -- every result ERROR/plan-failed, exit 5', async () => {
    const repo = draftRepo('run-learn-graded-refuses');
    try {
      const { exitCode, report } = await runJson(repo, ['--all']);
      assert.equal(exitCode, ExitCode.NO_VERDICT);
      assert.equal(report.results.length, 3);
      for (const r of report.results) {
        assert.equal(r.verdict, 'ERROR');
        assert.equal(r.reason, 'plan-failed');
      }
    } finally { repo.cleanup(); }
  });

  test('--id selection is unaffected by --learn', async () => {
    const repo = draftRepo('run-learn-ids');
    try {
      const { report } = await runJson(repo, ['--id', 'm1', '--id', 'm2', '--learn']);
      assert.equal(report.results.length, 2);
      assert.deepEqual(report.results.map((r) => r.id).sort(), ['m1', 'm2']);
    } finally { repo.cleanup(); }
  });
});
