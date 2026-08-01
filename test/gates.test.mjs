// THE NEGATIVE CONTROLS.
//
// The gates exist because of two specific catastrophes:
//   - a test command that silently runs zero tests reports every mutant SURVIVED,
//     making every finding false;
//   - a command that always errors reports every mutant KILLED, a fake-clean sweep.
// So the tests that matter most here are the ones where the harness is broken and
// the runner must REFUSE rather than produce numbers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { Reason, Verdict } from '../lib/classify.mjs';
import { CanaryStatus } from '../lib/gates.mjs';
import { ExitCode, exitCodeFor } from '../lib/report.mjs';
import { guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');

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

async function run(repo, mutants = [MUTANT], overrides = {}) {
  const config = loadConfig({ repoRoot: repo.root, overrides });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  return execute({ config, adapter, mutants });
}

describe('baseline gate', () => {
  test('a command that always errors STOPS the run -- it does not make every mutant KILLED', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { baselineCommand: 'exit 1', isolation: 'copy' },
      label: 'always-errors',
    });
    try {
      const report = await run(repo);
      assert.equal(report.gates.baseline.outcome, 'failed');
      assert.deepEqual(report.results, [], 'no mutant may get a verdict from a broken baseline');
      assert.equal(report.gates.canary, undefined, 'the canary should not even be attempted');
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  test('a baseline that runs zero tests is refused', async () => {
    const repo = makeRepo({
      files: guardFiles(),
      config: { baselineCommand: 'true', isolation: 'copy' },
      label: 'zero-tests',
    });
    try {
      const report = await run(repo);
      assert.equal(report.gates.baseline.outcome, 'failed');
      assert.match(report.gates.baseline.detail, /ran ZERO tests/);
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); }
  });

  test('a baseline with a pre-existing failure is refused (the dirty-baseline failure)', async () => {
    const files = guardFiles();
    files['test/broken.test.mjs'] = "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('already failing', () => { assert.equal(1, 2); });\n";
    const repo = makeRepo({ files, config: { isolation: 'copy' }, label: 'dirty-baseline' });
    try {
      const report = await run(repo);
      assert.equal(report.gates.baseline.outcome, 'failed');
      assert.match(report.gates.baseline.detail, /already failing before any mutation/);
    } finally { repo.cleanup(); }
  });
});

describe('canary gate', () => {
  test('a command that reports green NO MATTER WHAT fails the canary, not the run', async () => {
    // The baseline passes because the command lies about being green. Only the
    // canary can catch this: a guaranteed-failing test is injected and the command
    // still reports success, which means every mutant would read SURVIVED.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-liar-'));
    const repo = makeRepo({
      files: guardFiles(),
      config: {
        baselineCommand: `CM_FAKE_ALWAYS_GREEN=1 CM_FAKE_STATE=${JSON.stringify(path.join(scratch, 's'))} node ${JSON.stringify(STAGED)}`,
        isolation: 'copy',
      },
      label: 'lying-command',
    });
    try {
      const report = await run(repo);
      assert.equal(report.gates.baseline.outcome, 'passed', 'the liar passes the baseline gate');
      assert.equal(report.gates.canary.outcome, 'failed');
      assert.equal(report.gates.canary.status, CanaryStatus.FAILED);
      assert.match(report.gates.canary.detail, /still reported no failures/);
      assert.match(report.gates.canary.detail, /every finding would be false/);
      assert.deepEqual(report.results, [], 'no verdicts from an unverified harness');
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('the canary is synthesised, KILLED, then discarded with no residue', async () => {
    const repo = makeRepo({ files: guardFiles(), label: 'canary-clean' });
    try {
      const statusBefore = repo.status();
      const report = await run(repo, [], { isolation: 'in-place' });
      assert.equal(report.gates.canary.status, CanaryStatus.KILLED);
      assert.equal(report.gates.canary.grade, 'counted');
      assert.equal(report.gates.canary.target, 'test/guard.test.mjs');
      assert.match(report.gates.canary.detail, /then discarded/);
      // The canary lands on a path no catalog entry names, so this is the
      // assertion its residue would show up in.
      assert.equal(repo.status(), statusBefore, 'the canary must leave no trace');
      assert.equal(report.noTrace.ok, true);
    } finally { repo.cleanup(); }
  });

  test('a canary that produces a COMPILE break fails the gate rather than counting as a kill', async () => {
    // Interpretation, stated in the plan: the design says the canary must "come
    // back KILLED". A compile break classifies as IMPRECISE, so it must fail this
    // gate -- fail-safe, so a canary can never pass by accident.
    const configDir = null;
    const repo = makeRepo({
      files: guardFiles(),
      config: { runner: 'custom', isolation: 'copy' },
      label: 'canary-compiles-badly',
    });
    try {
      write(repo.root, 'harness/mutation/parse.mjs', `
        export const grade = 'counted';
        export const canNameFilter = false;
        export const testFilePatterns = ['**/*.test.mjs'];
        export function parse(stdout, stderr, exitCode) {
          const broke = /SyntaxError/.test(stdout + stderr);
          return {
            grade: 'counted',
            passed: broke ? 0 : 3,
            failed: broke ? 1 : 0,
            skipped: 0,
            ran: broke ? 1 : 3,
            failedTests: [],
            compileError: broke,
            counts: {},
          };
        }
        export function canary(source, { file }) {
          return {
            content: source + '\\nCANARY_BREAKS_THE_BUILD(((\\n',
            testId: 'canary',
            matches: () => true,
          };
        }
      `);
      const report = await run(repo, []);
      assert.equal(report.gates.baseline.outcome, 'passed');
      assert.equal(report.gates.canary.status, CanaryStatus.FAILED);
      assert.match(report.gates.canary.detail, /compile\/parse break/);
      assert.match(report.gates.canary.detail, /precision cannot be established/);
      assert.equal(report.gates.canary.attempts.length, 1, 'only one candidate file exists');
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
      assert.equal(configDir, null);
    } finally { repo.cleanup(); }
  });

  test('an adapter that cannot find a target file fails loudly instead of passing', async () => {
    const repo = makeRepo({
      files: { 'src/guard.mjs': guardFiles()['src/guard.mjs'] },
      config: { runner: 'custom', isolation: 'copy' },
      label: 'canary-no-target',
    });
    try {
      write(repo.root, 'harness/mutation/parse.mjs', `
        export function parse() {
          return { grade: 'counted', passed: 1, failed: 0, skipped: 0, ran: 1,
                   failedTests: [], compileError: false, counts: {} };
        }
      `);
      const report = await run(repo, []);
      assert.equal(report.gates.baseline.outcome, 'passed');
      assert.equal(report.gates.canary.status, CanaryStatus.FAILED);
      assert.match(report.gates.canary.detail, /cannot synthesise a canary/);
    } finally { repo.cleanup(); }
  });
});

describe('narrow baseline (the delta reference, and a second zero-test guard)', () => {
  test('a narrow scope that runs ZERO tests is ERROR, never SURVIVED', async () => {
    // Real `node --test` output for a scope that matches nothing: tests 0, exit 0.
    // (A no-test FILE is not that case -- node reports the file itself as one
    // passing test, so file-granularity scopes rarely reach ran=0. A mis-scoped
    // narrowCommand is how this shape actually shows up.)
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, label: 'scope-empty' });
    try {
      const report = await run(repo, [{
        ...MUTANT,
        id: 'aimed-at-nothing',
        narrowCommand: "node --test 'test/no-such-file-*.test.mjs'",
      }]);

      assert.equal(report.gates.baseline.outcome, 'passed');
      const result = report.results[0];
      assert.equal(
        result.verdict,
        Verdict.ERROR,
        `a zero-test scope must not read SURVIVED (got ${result.verdict})`,
      );
      assert.equal(result.reason, Reason.SCOPE_EMPTY);
      assert.match(result.detail, /ran ZERO tests/);
      // Not a survivor, but also not a clean proof.
      assert.equal(exitCodeFor(report), ExitCode.NO_VERDICT);
    } finally { repo.cleanup(); }
  });

  test('a narrow scope that is already failing is ERROR, never a coverage finding', async () => {
    const files = guardFiles();
    files['test/broken.test.mjs'] = "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('already failing', () => { assert.equal(1, 2); });\n";
    const repo = makeRepo({
      files,
      // Baseline deliberately excludes the broken file so the baseline gate passes
      // and the NARROW scope is the thing that is broken.
      config: { baselineCommand: "node --test 'test/guard.test.mjs'", isolation: 'copy' },
      label: 'scope-broken',
    });
    try {
      const report = await run(repo, [{
        ...MUTANT,
        id: 'broken-scope',
        expectFail: ['test/broken.test.mjs::already failing'],
      }]);
      assert.equal(report.gates.baseline.outcome, 'passed');
      // The first canary candidate (test/broken.test.mjs, alphabetically) sits
      // outside the baseline command's scope, so the gate falls through to a file
      // that is covered rather than failing the whole run.
      assert.equal(report.gates.canary.status, CanaryStatus.KILLED);
      assert.equal(report.gates.canary.target, 'test/guard.test.mjs');
      assert.equal(report.results[0].verdict, Verdict.ERROR);
      assert.equal(report.results[0].reason, Reason.SCOPE_NON_GREEN);
    } finally { repo.cleanup(); }
  });

  test('the narrow baseline is memoised per resolved command', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'copy' }, label: 'memo' });
    try {
      // Three mutants sharing one scope: they pay one extra run between them, and
      // every result carries the same reference measurement.
      const report = await run(repo, [
        { ...MUTANT, id: 'a' },
        { ...MUTANT, id: 'b', sites: [{ file: 'src/guard.mjs', anchor: "kind === 'ollama'", replacement: 'false' }], expectFail: ['test/guard.test.mjs::allows ollama'] },
        { ...MUTANT, id: 'c', sites: [{ file: 'src/guard.mjs', anchor: 'return true;', replacement: 'return false;' }], expectFail: ['test/guard.test.mjs::allows ollama'] },
      ]);
      const commands = new Set(report.results.map((r) => r.narrowBaseline.command));
      assert.equal(commands.size, 1, 'all three share one narrow scope');
      for (const result of report.results) {
        assert.deepEqual(result.narrowBaseline.counts, { passed: 3, failed: 0, skipped: 0, ran: 3 });
        assert.ok(result.delta, 'the delta must be present and computed against that scope');
      }
    } finally { repo.cleanup(); }
  });

  test('the delta compares the SAME scope, not the whole suite against a narrowed run', async () => {
    const files = guardFiles();
    files['test/other.test.mjs'] = "import { test } from 'node:test';\n"
      + "test('unrelated one', () => {});\ntest('unrelated two', () => {});\n";
    const repo = makeRepo({ files, config: { isolation: 'copy' }, label: 'delta' });
    try {
      const report = await run(repo);
      const result = report.results[0];
      // The full baseline saw 5 tests; the narrow scope saw 3. If the delta used
      // the full baseline it would read -4/+1/0 and look like carnage.
      assert.equal(report.gates.baseline.counts.ran, 5);
      assert.equal(result.narrowBaseline.counts.ran, 3);
      assert.deepEqual(result.delta, { passed: -1, failed: 1, skipped: 0 });
    } finally { repo.cleanup(); }
  });
});

describe('exit-code grade gates', () => {
  function exitCodeRepo(label, extraConfig = {}) {
    return makeRepo({
      files: guardFiles(),
      config: {
        runner: 'exit-code',
        baselineCommand: "node --check src/guard.mjs",
        testCommand: "node --check src/guard.mjs",
        isolation: 'copy',
        ...extraConfig,
      },
      label,
    });
  }

  test('the baseline canary is NOT-ESTABLISHED, and that is not a stop condition', async () => {
    const repo = exitCodeRepo('exit-baseline');
    try {
      const report = await run(repo, []);
      assert.equal(report.gates.baseline.outcome, 'passed');
      assert.equal(report.gates.canary.status, CanaryStatus.NOT_ESTABLISHED);
      // NOT rendered as 'passed': a reader must be able to tell "the gate
      // observed a failure" from "the gate was never asked to prove it could".
      assert.equal(report.gates.canary.outcome, 'not-established');
      assert.match(report.gates.canary.detail, /established.*per-mutant during `run`/);
      assert.equal(exitCodeFor(report), ExitCode.CLEAN);
    } finally { repo.cleanup(); }
  });

  test('a SURVIVED in exit-code mode is checked with a per-mutant canary before being believed', async () => {
    const repo = exitCodeRepo('exit-survivor');
    try {
      // `node --check` only cares about syntax, so this mutation genuinely
      // survives -- and the lazy canary confirms the gate does look at the file.
      const report = await run(repo, [MUTANT]);
      const result = report.results[0];
      assert.equal(result.verdict, Verdict.SURVIVED);
      assert.equal(result.grade, 'exit-code');
      assert.equal(result.canary.status, CanaryStatus.KILLED);
      assert.equal(result.canary.grade, 'exit-code');
      assert.equal(exitCodeFor(report), ExitCode.SURVIVORS);
    } finally { repo.cleanup(); }
  });

  test('a gate that ignores the mutated file turns its SURVIVED into ERROR, not a finding', async () => {
    const repo = exitCodeRepo('exit-blind', { testCommand: 'true', baselineCommand: 'true' });
    try {
      const report = await run(repo, [MUTANT]);
      const result = report.results[0];
      assert.equal(
        result.verdict,
        Verdict.ERROR,
        'a gate that cannot see the file must not produce a survivor',
      );
      assert.equal(result.reason, 'canary-not-established');
      assert.equal(result.canary.status, CanaryStatus.FAILED);
      assert.equal(exitCodeFor(report), ExitCode.NO_VERDICT);
    } finally { repo.cleanup(); }
  });

  test('an exit-code KILLED needs no canary -- the mutation itself proved observation', async () => {
    const repo = exitCodeRepo('exit-killed');
    try {
      const report = await run(repo, [{
        ...MUTANT,
        id: 'syntax-breaker',
        // Makes the file unparseable, so `node --check` fails.
        sites: [{ file: 'src/guard.mjs', anchor: 'export function isAllowed(kind) {', replacement: 'export function isAllowed(kind) {{{' }],
        expectFail: [],
      }]);
      const result = report.results[0];
      assert.equal(result.verdict, Verdict.KILLED);
      assert.equal(result.grade, 'exit-code');
      assert.equal(result.canary, null, 'no per-mutant canary needed for a kill');
      assert.match(result.detail, /precision was NOT established/);
    } finally { repo.cleanup(); }
  });
});

describe('reported jobs reflects effective concurrency', () => {
  test('in-place isolation reports jobs:1 even if config.jobs was never clamped', async () => {
    const repo = makeRepo({ files: guardFiles(), config: { isolation: 'in-place', jobs: 1 }, label: 'report-jobs' });
    try {
      const config = loadConfig({ repoRoot: repo.root });
      // Simulate a caller that built (or mutated) a config object without going
      // through loadConfig's own clamp -- the report must not blindly repeat it.
      config.jobs = 4;
      const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
      const report = await execute({ config, adapter, mutants: [] });
      assert.equal(report.jobs, 1, 'in-place isolation always runs serially, whatever config.jobs claims');
    } finally { repo.cleanup(); }
  });
});
