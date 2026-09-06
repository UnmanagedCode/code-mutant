// THE CANARY GATE, NARROWED TO THE COMMANDS THAT ACTUALLY JUDGE MUTANTS.
//
// In counted mode no verdict comes from `baselineCommand`: every verdict comes
// from the mutant's narrow command. So these claims are about WHICH COMMAND was
// attested, and they split three ways:
//
//   AC1  the canary runs the mutant's own scope, once per DISTINCT scope;
//   AC2  everything the gate cannot soundly narrow falls back to the
//        baseline-scope canary, unchanged -- each case below names a CORRECT
//        harness that a looser eligibility rule would wrongly fail;
//   AC3  a scope that cannot be shown to observe a failure ERRORs its own
//        mutants and says so loudly, while a run that attested NOTHING is still
//        the wholesale refusal it always was.
//
// The instrument for "which command ran, and how many times" is
// test/helpers/counting-command.mjs via makeCounter() -- a fact about commands,
// never a wall clock.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { Verdict } from '../lib/classify.mjs';
import { CanaryStatus, GateOutcome } from '../lib/gates.mjs';
import { ExitCode, exitCodeFor, formatReport } from '../lib/report.mjs';
import { execute } from '../lib/runner.mjs';
import { guardFiles, makeRepo } from './helpers/tmp-repo.mjs';
import { runCli } from './helpers/cli.mjs';
import { makeCounter } from './helpers/command-counter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COUNTING = path.join(HERE, 'helpers', 'counting-command.mjs');
const STAGED = path.join(HERE, 'helpers', 'staged-command.mjs');
const NODE_TEST_MODULE = pathToFileURL(path.join(HERE, '..', 'lib', 'adapters', 'node-test.mjs')).href;
const SCHEMA_DOC = path.join(HERE, '..', 'mutants.schema.md');

// A SECOND module+test beside guardFiles(), so the whole suite is strictly larger
// than any one scope -- which is what makes "the canary ran the scope, not the
// suite" an observable difference rather than a coincidence.
const PARSE_SOURCE = `export function parseFlag(text) {
  return text === '--on';
}
`;

const PARSE_TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlag } from '../src/parse.mjs';

test('parses --on', () => { assert.equal(parseFlag('--on'), true); });
test('rejects everything else', () => { assert.equal(parseFlag('--off'), false); });
`;

function twoScopeFiles() {
  return { ...guardFiles(), 'src/parse.mjs': PARSE_SOURCE, 'test/parse.test.mjs': PARSE_TESTS };
}

const GUARD_MUTANT = {
  id: 'guard-user-defined',
  invariant: 'the user-defined-backend branch is load-bearing',
  sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
  expectFail: ['test/guard.test.mjs::allows user-defined backends'],
  whyNotEquivalent: 'denies a backend the guard must admit',
};

const GUARD_MUTANT_2 = {
  id: 'guard-ollama',
  invariant: 'the ollama branch is load-bearing',
  sites: [{ file: 'src/guard.mjs', anchor: "if (kind === 'ollama') return true;", replacement: "if (kind === 'ollama') return false;" }],
  expectFail: ['test/guard.test.mjs::allows ollama'],
  whyNotEquivalent: 'refusing ollama is not accepting it',
};

const PARSE_MUTANT = {
  id: 'parse-on',
  invariant: 'parseFlag recognises --on',
  sites: [{ file: 'src/parse.mjs', anchor: "return text === '--on';", replacement: 'return false;' }],
  expectFail: ['test/parse.test.mjs::parses --on'],
  whyNotEquivalent: 'refusing --on is not parsing it',
};

// `node --test` with no file arguments discovers the whole suite; with a scope it
// runs that scope. So an entry with empty `args` in the counter's log is one
// whole-suite run: the baseline gate, or a baseline-scope canary attempt.
function countingConfig(overrides = {}) {
  return {
    baselineCommand: `node ${JSON.stringify(COUNTING)}`,
    testCommand: `node ${JSON.stringify(COUNTING)} {tests}`,
    runner: 'node-test',
    isolation: 'in-place',
    ...overrides,
  };
}

function writeCatalog(repo, mutants) {
  mkdirSync(path.join(repo.root, '.mutation'), { recursive: true });
  writeFileSync(path.join(repo.root, '.mutation', 'mutants.json'), `${JSON.stringify({ mutants }, null, 2)}\n`);
}

async function runJson(repo, args, env = {}) {
  const result = await runCli(args, { cwd: repo.root, env, timeoutMs: 300_000 });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* a usage error emits no report */ }
  return { ...result, report };
}

// In process, with env vars set around the call: the fake commands read them, and
// a --json child would hide the report object these claims render by hand.
async function runInProcess(repo, mutants, env = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const config = loadConfig({ repoRoot: repo.root });
    const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
    return await execute({ config, adapter, mutants });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('AC1: the canary is established against the command that judges the mutant', () => {
  test('N1: one mutant -- the canary runs its narrow scope, and the whole suite runs once', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: twoScopeFiles(), config: countingConfig(), label: 'cn-one-scope' });
    try {
      writeCatalog(repo, [GUARD_MUTANT]);
      const statusBefore = repo.status();

      const run = await runJson(repo, ['run', '--all', '--json'], counter.env);
      assert.equal(run.exitCode, 0, run.stderr);
      const { canary } = run.report.gates;

      // THE MEASUREMENT. Before this change the floor was 2: the baseline gate
      // plus a whole-suite canary. Now the canary runs the judging command, so
      // the whole suite is issued exactly once -- by the baseline gate.
      assert.equal(
        counter.wholeSuite(),
        1,
        `expected 1 whole-suite run, got ${counter.wholeSuite()}: ${JSON.stringify(counter.entries())}`,
      );
      assert.equal(canary.scope, 'narrow');
      assert.equal(canary.status, CanaryStatus.KILLED, canary.detail);
      assert.equal(canary.scopes.length, 1);
      // The SAME command string the mutant is judged by, not merely a narrow one.
      assert.equal(canary.scopes[0].command, run.report.narrowBaselines[0].command);
      assert.equal(canary.scopes[0].command, run.report.results[0].narrowing.command);
      assert.equal(canary.scopes[0].target, 'test/guard.test.mjs');
      assert.equal(canary.scopes[0].skipped, null);

      // And it left nothing behind: the canary is injected into a real test file
      // in the working tree, so residue would show up here.
      assert.equal(repo.status(), statusBefore, 'the narrow canary must leave no trace');
      assert.equal(run.report.noTrace.ok, true);
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('N2: three mutants over two scopes -- one canary per DISTINCT scope', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: twoScopeFiles(), config: countingConfig(), label: 'cn-two-scopes' });
    try {
      writeCatalog(repo, [GUARD_MUTANT, GUARD_MUTANT_2, PARSE_MUTANT]);

      const run = await runJson(repo, ['run', '--all', '--json'], counter.env);
      assert.equal(run.exitCode, 0, run.stderr);
      const { canary } = run.report.gates;

      // BOTH DIRECTIONS. An implementation that attested one scope and assumed
      // the rest passes `<=` and fails `>=`; one that ran a canary per MUTANT
      // gives 3 and fails `<=`. Only "per distinct scope" satisfies both.
      assert.equal(canary.scopes.length, 2, JSON.stringify(canary.scopes.map((s) => s.command)));
      assert.deepEqual(
        new Set(canary.scopes.map((s) => s.command)),
        new Set(run.report.narrowBaselines.map((b) => b.command)),
        'exactly the scopes that were measured are the scopes that were attested',
      );
      assert.equal(canary.status, CanaryStatus.KILLED, canary.detail);
      assert.equal(counter.wholeSuite(), 1, JSON.stringify(counter.entries()));
      for (const result of run.report.results) {
        assert.equal(result.verdict, Verdict.KILLED, `${result.id}: ${result.detail}`);
      }
    } finally { repo.cleanup(); counter.cleanup(); }
  });
});

describe('AC2: everything that cannot be soundly narrowed falls back, unchanged', () => {
  test('N3: `baseline` has no judging command, so the gate is baseline-scope', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: twoScopeFiles(), config: countingConfig(), label: 'cn-baseline' });
    try {
      const run = await runJson(repo, ['baseline', '--json'], counter.env);
      assert.equal(run.exitCode, 0, run.stderr);
      const { canary } = run.report.gates;

      // THE REGRESSION PIN for the whole pre-existing path: same record, plus the
      // three fields that say which scope it is about.
      assert.equal(canary.scope, 'baseline');
      assert.equal(canary.command, run.report.gates.baseline.command);
      assert.equal(canary.scopes, null);
      assert.equal(canary.status, CanaryStatus.KILLED, canary.detail);
      assert.equal(canary.target, 'test/guard.test.mjs');
      assert.equal(counter.wholeSuite(), 2, 'the baseline gate plus one whole-suite canary attempt');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('N4: `narrowTo: "names"` falls back -- the command filters the canary out by construction', async () => {
    // THE LOAD-BEARING EXCLUSION. substitute() prepends
    // `--test-name-pattern ^(expectFail…)$`, which cannot match the canary's
    // synthesised label, so a narrow canary here would report FAILED against a
    // perfectly good harness. Eligibility keyed on "scopes.length > 0" fails here.
    const counter = makeCounter();
    const repo = makeRepo({ files: twoScopeFiles(), config: countingConfig(), label: 'cn-names' });
    try {
      writeCatalog(repo, [{
        ...GUARD_MUTANT,
        narrowTo: 'names',
        expectPass: ['test/guard.test.mjs::allows ollama'],
      }]);

      const run = await runJson(repo, ['run', '--all', '--json'], counter.env);
      assert.equal(run.exitCode, 0, run.stderr);
      assert.equal(run.report.results[0].narrowing.mode, 'names');
      assert.match(
        run.report.results[0].narrowing.command,
        /--test-name-pattern/,
        'the fixture must really be judged by a name-filtering command',
      );
      assert.equal(run.report.gates.canary.scope, 'baseline');
      assert.equal(run.report.gates.canary.status, CanaryStatus.KILLED, run.report.gates.canary.detail);
      assert.equal(counter.wholeSuite(), 2, 'the baseline gate plus one whole-suite canary attempt');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('N5: a per-mutant `narrowCommand` falls back -- it names no scope to inject into', async () => {
    const repo = makeRepo({ files: twoScopeFiles(), config: countingConfig(), label: 'cn-command' });
    try {
      writeCatalog(repo, [{
        ...GUARD_MUTANT,
        narrowCommand: `node ${JSON.stringify(COUNTING)} 'test/guard.test.mjs'`,
      }]);

      const run = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(run.exitCode, 0, run.stderr);
      assert.equal(run.report.results[0].narrowing.mode, 'command');
      assert.equal(run.report.gates.canary.scope, 'baseline');
      assert.equal(run.report.gates.canary.status, CanaryStatus.KILLED, run.report.gates.canary.detail);
    } finally { repo.cleanup(); }
  });

  test('N6: a mixed catalog runs BOTH -- the unnarrowable mutant requires the baseline scope', async () => {
    const counter = makeCounter();
    const repo = makeRepo({ files: twoScopeFiles(), config: countingConfig(), label: 'cn-mixed' });
    try {
      writeCatalog(repo, [
        GUARD_MUTANT,
        { ...PARSE_MUTANT, narrowTo: 'names', expectPass: ['test/parse.test.mjs::rejects everything else'] },
      ]);

      const run = await runJson(repo, ['run', '--all', '--json'], counter.env);
      assert.equal(run.exitCode, 0, run.stderr);
      const { canary } = run.report.gates;

      assert.equal(canary.scope, 'mixed');
      assert.equal(canary.command, run.report.gates.baseline.command, 'the baseline half names its command');
      assert.equal(canary.scopes.length, 1, 'exactly the one narrowable mutant is attested narrowly');
      assert.equal(canary.scopes[0].command, run.report.results[0].narrowing.command);
      assert.equal(canary.status, CanaryStatus.KILLED, canary.detail);
      assert.equal(counter.wholeSuite(), 2, 'one unnarrowable mutant is enough to require the baseline half');
    } finally { repo.cleanup(); counter.cleanup(); }
  });

  test('N7: an adapter whose refs do NOT name files falls back, whatever its scopes look like', async () => {
    // Keyed on the DOCUMENTED INTERFACE, never on an incidental existsSync: a
    // parser that overrides scopeOf declares refsNameFiles false by default
    // (dotnet returns a declaring type, not a path). This fixture's scopes happen
    // to be real files, so an implementation that keyed on "does the file exist"
    // would narrow here -- against an adapter that never promised a path.
    const files = twoScopeFiles();
    files['harness/mutation/parse.mjs'] = `
      export { parse, canary } from ${JSON.stringify(NODE_TEST_MODULE)};
      export const testFilePatterns = ['test/**/*.test.mjs'];
      // Overriding scopeOf is what makes refsNameFiles default to false.
      export function scopeOf(ref) { return String(ref).split('::')[0]; }
    `;
    const repo = makeRepo({
      files,
      config: countingConfig({ runner: 'custom' }),
      label: 'cn-refs-not-files',
    });
    try {
      writeCatalog(repo, [GUARD_MUTANT]);

      const run = await runJson(repo, ['run', '--all', '--json']);
      assert.equal(run.exitCode, 0, run.stderr);
      // The fixture is otherwise healthy and WOULD have been eligible: file
      // granularity, a real scope, a mutant that grades.
      assert.equal(run.report.results[0].narrowing.mode, 'file');
      assert.deepEqual(run.report.results[0].narrowing.scopes, ['test/guard.test.mjs']);
      assert.equal(run.report.results[0].verdict, Verdict.KILLED, run.report.results[0].detail);
      assert.equal(run.report.gates.canary.scope, 'baseline');
      assert.equal(run.report.gates.canary.status, CanaryStatus.KILLED, run.report.gates.canary.detail);
    } finally { repo.cleanup(); }
  });
});

describe('AC3: an unattested scope refuses its own mutants, loudly', () => {
  test('N8: one lying scope is PARTIAL -- its mutants ERROR, the attested scope still grades', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-partial-'));
    const repo = makeRepo({
      files: twoScopeFiles(),
      // baselineCommand is real; the judging command lies about being green for
      // the parse scope ALONE and runs the real thing for every other scope.
      config: {
        baselineCommand: 'node --test',
        testCommand: `node ${JSON.stringify(STAGED)} {tests}`,
        runner: 'node-test',
        isolation: 'in-place',
      },
      label: 'cn-partial',
    });
    try {
      const report = await runInProcess(repo, [GUARD_MUTANT, PARSE_MUTANT], {
        CM_FAKE_STATE: path.join(scratch, 'invocations'),
        CM_FAKE_GREEN_FOR: 'parse',
      });
      const { canary } = report.gates;

      assert.equal(canary.status, CanaryStatus.PARTIAL, canary.detail);
      assert.equal(canary.outcome, GateOutcome.PARTIAL);
      // THE PROPERTY ALL-OR-NOTHING WOULD VIOLATE: one unattested scope out of two
      // must not fail the whole run. The refused mutants carry the consequence
      // themselves, through noVerdict.
      assert.notEqual(exitCodeFor(report), ExitCode.GATE_FAILED);
      assert.equal(exitCodeFor(report), ExitCode.NO_VERDICT);

      const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
      assert.equal(byId['parse-on'].verdict, Verdict.ERROR);
      assert.equal(byId['parse-on'].reason, 'canary-not-established');
      assert.equal(
        byId['parse-on'].failedTests,
        null,
        'an ungraded result must never carry [] -- that is a SURVIVED\'s shape',
      );
      assert.equal(byId['guard-user-defined'].verdict, Verdict.KILLED, byId['guard-user-defined'].detail);

      // AND IT IS LOUD ON THE HUMAN SURFACE, not only in --json: a reader
      // skimming the gate block must not be able to take this for a pass.
      const text = formatReport(report);
      const lying = canary.scopes.find((s) => s.status !== CanaryStatus.KILLED);
      assert.match(text, /PARTIAL/);
      assert.match(text, /canary-not-established/);
      assert.ok(text.includes(lying.command), `the unattested command must be named:\n${text}`);
      assert.doesNotMatch(text, /canary +KILLED/, 'a partial gate must never render as a kill');
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('N9: when NOTHING could be attested the refusal is wholesale, exactly as before', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-nothing-'));
    const repo = makeRepo({
      files: twoScopeFiles(),
      config: {
        baselineCommand: 'node --test',
        testCommand: `node ${JSON.stringify(STAGED)} {tests}`,
        runner: 'node-test',
        isolation: 'in-place',
      },
      label: 'cn-all-lying',
    });
    try {
      // Every scope's judging command lies, so nothing at all is attested.
      const report = await runInProcess(repo, [GUARD_MUTANT, PARSE_MUTANT], {
        CM_FAKE_STATE: path.join(scratch, 'invocations'),
        CM_FAKE_ALWAYS_GREEN: '1',
      });

      assert.equal(report.gates.canary.status, CanaryStatus.FAILED, report.gates.canary.detail);
      assert.equal(report.gates.canary.outcome, GateOutcome.FAILED);
      assert.deepEqual(report.results, [], 'no verdicts from a harness that observes nothing');
      assert.equal(exitCodeFor(report), ExitCode.GATE_FAILED);
    } finally { repo.cleanup(); rmSync(scratch, { recursive: true, force: true }); }
  });

  test('N10: the gate line names the scope, and one line per judging command', () => {
    // Pure, at the report layer: hand-built records, no fixture, no subprocess.
    const baseReport = (canary) => ({
      command: 'run',
      isolation: 'in-place',
      jobs: 1,
      learn: false,
      adapter: { name: 'node-test', grade: 'counted', modulePath: null },
      mutatedSha: 'a'.repeat(40),
      reproducible: true,
      gates: {
        baseline: {
          outcome: 'passed',
          command: 'node --test',
          counts: { passed: 3, failed: 0, skipped: 0, ran: 3 },
          detail: 'baseline is green',
          fromCache: false,
        },
        canary,
      },
      narrowBaselines: [],
      results: [],
      noTrace: null,
      gateCache: null,
    });

    const baseline = formatReport(baseReport({
      outcome: 'passed',
      status: 'KILLED',
      scope: 'baseline',
      grade: 'counted',
      command: 'node --test',
      target: 'test/guard.test.mjs',
      attempts: [],
      scopes: null,
      durationMs: 12,
      detail: 'the synthesised canary fired, then discarded',
      fromCache: false,
      measuredDurationMs: null,
    }));
    assert.match(baseline, /canary {4}KILLED {2}\[counted grade, baseline scope\]/);
    assert.match(baseline, /via test\/guard\.test\.mjs/);

    const narrow = formatReport(baseReport({
      outcome: 'partial',
      status: 'PARTIAL',
      scope: 'narrow',
      grade: 'counted',
      command: null,
      target: null,
      attempts: [],
      scopes: [
        {
          command: "node --test 'test/guard.test.mjs'",
          target: 'test/guard.test.mjs',
          status: 'KILLED',
          grade: 'counted',
          attempts: [],
          durationMs: 5,
          detail: 'the synthesised canary was the single observed failure',
          mutants: ['g-1'],
          skipped: null,
        },
        {
          command: "node --test 'test/parse.test.mjs'",
          target: 'test/parse.test.mjs',
          status: 'FAILED',
          grade: 'counted',
          attempts: [],
          durationMs: 4,
          detail: 'a guaranteed-failing test was injected and the command still reported no failures',
          mutants: ['p-1', 'p-2'],
          skipped: null,
        },
      ],
      durationMs: 9,
      detail: '1 of 2 command(s) that judge a mutant were shown to observe a deliberate break',
      fromCache: false,
      measuredDurationMs: null,
    }));
    assert.match(narrow, /canary {4}PARTIAL {2}\[counted grade, narrow scope\]/);
    assert.match(narrow, /1 of 2 scope\(s\) attested/);
    assert.match(narrow, /- node --test 'test\/guard\.test\.mjs' {3}KILLED {2}via test\/guard\.test\.mjs/);
    assert.match(narrow, /- node --test 'test\/parse\.test\.mjs' {3}NOT FIRED {2}a guaranteed-failing test/);
    assert.match(narrow, /mutants refused: p-1, p-2/);
    assert.match(narrow, /CANARY PARTIAL -- 1 of 2 narrowed scope\(s\)/);
  });
});

describe('AC4: the documented vocabulary is complete', () => {
  test('N11: mutants.schema.md names every canary status and gate outcome', () => {
    // The same discipline test/ungraded-shape.test.mjs applies to Reason: a status
    // added in code without a line in the schema fails the suite rather than
    // shipping a --json field no consumer can look up. Presence only, not prose.
    const doc = readFileSync(SCHEMA_DOC, 'utf8');
    for (const status of Object.values(CanaryStatus)) {
      assert.ok(doc.includes(status), `mutants.schema.md does not name CanaryStatus ${status}`);
    }
    for (const outcome of Object.values(GateOutcome)) {
      assert.ok(doc.includes(`"${outcome}"`), `mutants.schema.md does not name GateOutcome ${outcome}`);
    }
  });
});
