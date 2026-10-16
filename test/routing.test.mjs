// Routing: the composite adapter, the route driver, and the per-route checks
// that keep one route's failure from hiding behind another's green. Cheap: the
// routes here are node-only, and envelopes are built from real captured output.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AdapterError, missingCanaryExports } from '../lib/adapters/index.mjs';
import { Reason, Verdict, classify } from '../lib/classify.mjs';
import { MAX_CAPTURE_BYTES, liveChildCount } from '../lib/exec.mjs';
import { isGreen, measure } from '../lib/measure.mjs';
import { planNarrowing } from '../lib/narrow.mjs';
import { ENVELOPE_MARKER, runRoutes } from '../lib/route-exec.mjs';
import { compileRoutedCommand, loadHarness } from '../lib/routing.mjs';
import { ExitCode } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { git, guardFiles, makeRepo, write } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_FIXTURES = path.join(HERE, 'fixtures', 'node-test');
const NODE_TEST_MODULE = pathToFileURL(path.join(HERE, '..', 'lib', 'adapters', 'node-test.mjs')).href;

const nodeFixture = (name) => readFileSync(path.join(NODE_FIXTURES, `${name}.stdout.txt`), 'utf8');

const ROUTES = [
  { name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test', baselineCommand: 'node --test test/', testCommand: 'node --test {tests}' },
  { name: 'web', tests: ['web/**/*.test.mjs', 'test/web-*.test.mjs'], runner: 'node-test', baselineCommand: 'node --test web/', testCommand: 'node --test --x {tests}' },
];

async function harness(routes = ROUTES) {
  return loadHarness({ routes, configDir: os.tmpdir(), baselineCommand: null, testCommand: null, runner: null });
}

function envelope(groups) {
  return `${ENVELOPE_MARKER} ${JSON.stringify({
    groups: groups.map((g) => ({
      exitCode: 0, signal: null, durationMs: 1, truncated: false, outputIncomplete: false, spawnError: null,
      stderr: '', reports: {}, ...g,
    })),
  })}\n`;
}

// Reaped or a zombie: either way no longer running. Polled briefly, since a
// SIGKILLed process is reaped asynchronously.
async function stillRunning(pid) {
  const running = () => {
    const status = `/proc/${pid}/status`;
    return existsSync(status) && !/^State:\s+Z/m.test(readFileSync(status, 'utf8'));
  };
  for (let i = 0; i < 50 && running(); i += 1) await new Promise((r) => { setTimeout(r, 20); });
  return running();
}

const RUN = { exitCode: 1, timedOut: false, truncated: false, outputIncomplete: false, spawnError: null, durationMs: 5 };

describe('the routed adapter', () => {
  test('substitute runs only the routes with a ref in scope, in declared order', async () => {
    const { adapter, config } = await harness();
    const narrowing = planNarrowing({
      mutant: { id: 'm', expectFail: ['web/a.test.mjs::x', 'test/b.test.mjs::y'] },
      adapter,
      testCommand: config.testCommand,
    });
    assert.equal(narrowing.placeholder, true);
    assert.deepEqual(narrowing.routes, ['unit', 'web']);
    assert.equal(narrowing.command, compileRoutedCommand([
      ['unit', "node --test 'test/b.test.mjs'"], ['web', "node --test --x 'web/a.test.mjs'"],
    ]));

    const unitOnly = planNarrowing({ mutant: { id: 'm', expectFail: ['test/b.test.mjs::y'] }, adapter, testCommand: config.testCommand });
    assert.deepEqual(unitOnly.routes, ['unit']);
    assert.equal(unitOnly.command, compileRoutedCommand([['unit', "node --test 'test/b.test.mjs'"]]));
  });

  test('the first route in declared order wins a file both match', async () => {
    const { adapter } = await harness();
    // test/web-x.test.mjs matches both unit's test/*.test.mjs and web's test/web-*.
    assert.equal(adapter.routeOf('test/web-x.test.mjs').name, 'unit');
  });

  test('an unrouted ref throws, naming every route\'s patterns, so the mutant is plan-failed', async () => {
    const { adapter, config } = await harness();
    assert.throws(
      () => planNarrowing({ mutant: { id: 'm', expectFail: ['lib/x.test.mjs::y'] }, adapter, testCommand: config.testCommand }),
      /lib\/x\.test\.mjs matches no route's tests \(unit: test\/\*\.test\.mjs; web: web\/\*\*\/\*\.test\.mjs, test\/web-\*\.test\.mjs\)/,
    );
  });

  test('the baseline is every route\'s baseline through the driver', async () => {
    const { config } = await harness();
    assert.equal(config.baselineCommand, compileRoutedCommand([['unit', 'node --test test/'], ['web', 'node --test web/']]));
  });

  test('no envelope reads as zero tests with a diagnostic, never green', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse('', 'boom\n', 1, {});
    assert.equal(parsed.ran, 0);
    assert.match(parsed.diagnostic, /route driver produced no envelope \(stderr: boom\)/);
    assert.equal(isGreen({ run: { ...RUN, exitCode: 0 }, parsed }), false);
  });
});

describe('per-route judgement', () => {
  // Invariant: a route with no tests is never a silent pass, whatever the other
  // routes did.
  test('a route that ran zero tests fails the baseline, naming the route, beside a green route', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse(envelope([
      { route: 'unit', stdout: nodeFixture('pass') },
      { route: 'web', stdout: '' },
    ]), '', 0, {});
    assert.equal(parsed.ran, 2, 'the merged counters alone look green');
    assert.equal(isGreen({ run: { ...RUN, exitCode: 0 }, parsed }), false);
    const { describeNotGreen } = await import('../lib/measure.mjs');
    assert.match(describeNotGreen({ run: { ...RUN, exitCode: 0 }, parsed }), /^route "web": the command ran ZERO tests/);
  });

  test('classify: a route exiting non-zero naming nothing is ERROR unexplained-exit, even when another route names the kill', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse(envelope([
      { route: 'unit', stdout: nodeFixture('fail'), exitCode: 1 },
      { route: 'web', stdout: nodeFixture('pass'), exitCode: 1 },
    ]), '', 1, {});
    const verdict = classify({
      run: RUN, parsed, expectFail: ['test/math.test.mjs::subtracts', 'test/math.test.mjs::nested > inner failure'],
    });
    assert.equal(verdict.verdict, Verdict.ERROR);
    assert.equal(verdict.reason, Reason.UNEXPLAINED_EXIT);
    assert.match(verdict.detail, /^route "web": /);
  });

  test('classify: a truncated route is ERROR output-truncated, naming the route', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse(envelope([
      { route: 'unit', stdout: nodeFixture('fail'), exitCode: 1 },
      { route: 'web', stdout: nodeFixture('pass'), truncated: true },
    ]), '', 1, {});
    const verdict = classify({ run: RUN, parsed, expectFail: ['test/math.test.mjs::subtracts'] });
    assert.equal(verdict.reason, Reason.OUTPUT_TRUNCATED);
    assert.match(verdict.detail, /^route "web": /);
  });

  // Invariant: a route whose command could not even start is ERROR
  // command-failed-to-start naming the route -- not the scope-empty its empty
  // output would otherwise read as.
  test('classify: a route that failed to start is ERROR command-failed-to-start, naming the route', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse(envelope([
      { route: 'unit', stdout: nodeFixture('fail'), exitCode: 1 },
      { route: 'web', stdout: '', exitCode: 127, spawnError: 'spawn /bin/sh ENOENT' },
    ]), '', 1, {});
    const verdict = classify({ run: RUN, parsed, expectFail: ['test/math.test.mjs::subtracts'] });
    assert.equal(verdict.verdict, Verdict.ERROR);
    assert.equal(verdict.reason, Reason.COMMAND_FAILED_TO_START);
    assert.equal(verdict.detail, 'route "web": the command could not be started: spawn /bin/sh ENOENT');
  });

  test('classify: a route that ran zero tests is ERROR scope-empty, naming the route', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse(envelope([
      { route: 'unit', stdout: nodeFixture('fail'), exitCode: 1 },
      { route: 'web', stdout: '' },
    ]), '', 1, {});
    const verdict = classify({ run: RUN, parsed, expectFail: ['test/math.test.mjs::subtracts'] });
    assert.equal(verdict.reason, Reason.SCOPE_EMPTY);
    assert.match(verdict.detail, /^route "web": this route ran zero tests/);
  });

  test('classify: clean groups are graded on the merged failing set', async () => {
    const { adapter } = await harness();
    const parsed = adapter.parse(envelope([
      { route: 'unit', stdout: nodeFixture('fail'), exitCode: 1 },
      { route: 'web', stdout: nodeFixture('pass') },
    ]), '', 1, {});
    const verdict = classify({
      run: RUN, parsed, expectFail: ['test/math.test.mjs::subtracts', 'test/math.test.mjs::nested > inner failure'],
    });
    assert.equal(verdict.verdict, Verdict.KILLED, verdict.detail);
  });
});

describe('the route driver', () => {
  const MODULE = "import { test } from 'node:test';\n";

  test('runs every route even after one fails, and exits 1', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-driver-'));
    try {
      write(root, 'a/one.test.mjs', `${MODULE}test('a fails', () => { throw new Error('x'); });\n`);
      write(root, 'b/two.test.mjs', `${MODULE}test('b passes', () => {});\n`);
      const { adapter } = await harness([
        { ...ROUTES[0], name: 'a', tests: ['a/*.test.mjs'] },
        { ...ROUTES[0], name: 'b', tests: ['b/*.test.mjs'] },
      ]);
      const command = compileRoutedCommand([['a', "node --test 'a/one.test.mjs'"], ['b', "node --test 'b/two.test.mjs'"]]);
      const config = { timeoutMs: 30_000, hang: { factor: 10, floorMs: 0 }, setup: null, teardown: null };
      const outcome = await measure({ command, config, adapter, workspace: { root } });
      assert.equal(outcome.run.exitCode, 1);
      assert.deepEqual(outcome.parsed.groups.map((g) => [g.route, g.exitCode, g.parsed.ran]), [['a', 1, 1], ['b', 0, 1]]);
      assert.deepEqual(outcome.parsed.failedTests.map((t) => t.id), ['a/one.test.mjs::a fails']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Invariant: a hung route cannot outlive the runner's deadline -- the group
  // kill reaches the driver's grandchildren, so nothing still reads a mutated
  // file while restore runs.
  test('a timeout kill reaches a route\'s grandchildren', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-kill-'));
    const pidFile = path.join(root, 'grandchild.pid');
    try {
      const { adapter } = await harness();
      const hang = `node -e 'setInterval(() => {}, 1000)' & echo $! > '${pidFile}'; wait`;
      const command = compileRoutedCommand([['unit', 'true'], ['web', hang]]);
      const config = { timeoutMs: 30_000, hang: { factor: 10, floorMs: 0 }, setup: null, teardown: null };
      const outcome = await measure({ command, config, adapter, workspace: { root }, deadlineMs: 1_000 });
      assert.equal(outcome.run.timedOut, true);
      assert.equal(liveChildCount(), 0);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.equal(await stillRunning(pid), false, `grandchild ${pid} survived the group kill`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Invariant: a route that leaves a process holding its inherited stdout
  // cannot pin the driver -- the run settles on the drain grace, honestly
  // reported as output-incomplete for that route, never as a timeout at the
  // full deadline -- and the holder dies with the runner's group once the
  // outer run ends.
  test('a route leaving a stdout holder behind settles as output-incomplete, not a timeout', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-holder-'));
    const pidFile = path.join(root, 'holder.pid');
    try {
      const { adapter } = await harness();
      // The shell exits at once; the backgrounded node keeps its stdout.
      const leak = `node -e 'setInterval(() => {}, 1000)' & echo $! > '${pidFile}'`;
      const command = compileRoutedCommand([['unit', leak]]);
      const config = { timeoutMs: 30_000, hang: { factor: 10, floorMs: 0 }, setup: null, teardown: null };
      const outcome = await measure({ command, config, adapter, workspace: { root }, deadlineMs: 15_000 });
      assert.equal(outcome.run.timedOut, false, 'the driver was pinned until the deadline');
      assert.ok(outcome.run.durationMs < 8_000, `settled after ${Math.round(outcome.run.durationMs)}ms`);
      const [group] = outcome.parsed.groups;
      assert.equal(group.run.outputIncomplete, true);
      const verdict = classify({ run: outcome.run, parsed: outcome.parsed, expectFail: ['test/a.test.mjs::x'] });
      assert.equal(verdict.reason, Reason.OUTPUT_INCOMPLETE);
      assert.match(verdict.detail, /^route "unit": /);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.equal(await stillRunning(pid), false, `holder ${pid} outlived the run`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Invariant: one capture budget spans every route's streams AND reports --
  // the envelope carries them all -- so routes that are each under the cap but
  // together over it are truncated, never silently passed through.
  describe('the capture budget across routes', () => {
    const half = Math.floor(MAX_CAPTURE_BYTES * 0.6);
    const report = (bytes) => `head -c ${bytes} /dev/zero > "$CODE_MUTANT_REPORT_DIR/r.json"`;
    const drive = async (pairs) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-budget-'));
      try {
        return await runRoutes(pairs, { cwd: root, env: { ...process.env, CODE_MUTANT_REPORT_DIR: root } });
      } finally { rmSync(root, { recursive: true, force: true }); }
    };

    test('a report that fits alone but not after an earlier route\'s is withheld and truncated', async () => {
      const groups = await drive([['a', report(half)], ['b', report(half)]]);
      assert.deepEqual(groups.map((g) => [g.truncated, Object.keys(g.reports)]), [[false, ['r.json']], [true, []]]);
    });

    test('once the budget is spent, a later route is truncated even with nothing to read', async () => {
      const groups = await drive([['a', report(MAX_CAPTURE_BYTES + 1)], ['b', 'echo fine']]);
      assert.deepEqual(groups.map((g) => g.truncated), [true, true]);
      assert.equal(groups[1].stdout, 'fine\n');
    });

    test('a route writing a report past the cap is ERROR output-truncated through the routed path', async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-cap-'));
      try {
        const { adapter } = await harness();
        const command = compileRoutedCommand([['unit', report(MAX_CAPTURE_BYTES + 1)]]);
        const config = { timeoutMs: 30_000, hang: { factor: 10, floorMs: 0 }, setup: null, teardown: null };
        const outcome = await measure({ command, config, adapter, workspace: { root } });
        assert.equal(outcome.run.truncated, false, 'the driver\'s own envelope fit');
        const verdict = classify({ run: outcome.run, parsed: outcome.parsed, expectFail: ['test/a.test.mjs::x'] });
        assert.equal(verdict.verdict, Verdict.ERROR);
        assert.equal(verdict.reason, Reason.OUTPUT_TRUNCATED);
        assert.match(verdict.detail, /^route "unit": /);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  test('each route gets its own report subdir, and only its own reports', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-reports-'));
    try {
      const seen = [];
      const recording = {
        grade: 'counted', refsNameFiles: true, canNameFilter: false, testFilePatterns: [], modulePath: null,
        parse: (stdout, stderr, exitCode, context) => {
          seen.push({ stdout: stdout.trim(), reports: context.reports });
          return { grade: 'counted', passed: 1, failed: 0, skipped: 0, ran: 1, failedTests: [], compileError: false, counts: {} };
        },
      };
      const { createRoutedAdapter } = await import('../lib/routing.mjs');
      const adapter = createRoutedAdapter(['a', 'b'].map((name) => ({
        name, tests: [`${name}/*`], regexes: [new RegExp(`^${name}/`)], runner: 'fake', adapter: recording,
      })));
      const write1 = (name) => `basename "$CODE_MUTANT_REPORT_DIR"; printf ${name} > "$CODE_MUTANT_REPORT_DIR/r.json"`;
      const command = compileRoutedCommand([['a', write1('a')], ['b', write1('b')]]);
      const config = { timeoutMs: 30_000, hang: { factor: 10, floorMs: 0 }, setup: null, teardown: null };
      await measure({ command, config, adapter, workspace: { root } });
      assert.deepEqual(seen, [{ stdout: 'a', reports: { 'r.json': 'a' } }, { stdout: 'b', reports: { 'r.json': 'b' } }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('routes that cannot be routed are refused at load', () => {
  test('an exit-code route', async () => {
    await assert.rejects(() => harness([{ ...ROUTES[0], runner: 'exit-code' }]),
      (err) => err instanceof AdapterError && /route "unit": runner "exit-code" cannot be routed: it is exit-code grade -- routing splits test FILES/.test(err.message));
  });

  test('a dotnet route', async () => {
    await assert.rejects(() => harness([{ ...ROUTES[0], runner: 'dotnet' }]),
      (err) => err instanceof AdapterError && /route "unit": runner "dotnet" cannot be routed: its test references do not name files/.test(err.message));
  });

  test('a custom route whose parser declares exit-code grade, or overrides scopeOf', async () => {
    for (const [body, pattern] of [
      [`export { parse } from ${JSON.stringify(NODE_TEST_MODULE)};\nexport const grade = 'exit-code';\n`, /exit-code grade/],
      [`export { parse, canary } from ${JSON.stringify(NODE_TEST_MODULE)};\nexport function scopeOf(ref) { return ref; }\n`, /do not name files/],
    ]) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-custom-'));
      try {
        write(dir, 'parse.mjs', body);
        await assert.rejects(
          () => loadHarness({ routes: [{ ...ROUTES[0], runner: 'custom' }], configDir: dir }),
          (err) => err instanceof AdapterError && pattern.test(err.message),
        );
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  // Invariant: a route missing canary() is refused as adapter-no-canary, named.
  test('a custom route with no canary() is missing it by route name', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-route-nocanary-'));
    try {
      write(dir, 'parse.mjs', `export { parse } from ${JSON.stringify(NODE_TEST_MODULE)};\n`);
      const { adapter } = await loadHarness({ routes: [ROUTES[0], { ...ROUTES[1], runner: 'custom' }], configDir: dir });
      assert.deepEqual(missingCanaryExports(adapter), ['canary(source, { file }) (route "web")']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an unknown runner names the route', async () => {
    await assert.rejects(() => harness([{ ...ROUTES[0], runner: 'cargo' }]), /route "unit": unknown runner "cargo"/);
  });
});

describe('routing through the CLI', () => {
  // Invariant: routing composes with `custom` -- one route parsed by the
  // harness's own parse.mjs, one by a shipped adapter, graded as one mutant.
  test('a custom route beside a node-test route grades KILLED', async () => {
    const files = guardFiles();
    files['spec/extra.spec.mjs'] = "import { test } from 'node:test';\ntest('extra', () => {});\n";
    const repo = makeRepo({
      files,
      config: {
        baselineCommand: undefined,
        testCommand: undefined,
        runner: undefined,
        routes: [
          { name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test', baselineCommand: "node --test 'test/*.test.mjs'", testCommand: 'node --test {tests}' },
          { name: 'spec', tests: ['spec/*.spec.mjs'], runner: 'custom', baselineCommand: "node --test 'spec/*.spec.mjs'", testCommand: 'node --test {tests}' },
        ],
      },
      mutants: [{
        id: 'routed',
        invariant: 'user-defined backends are allowed',
        whyNotEquivalent: 'denies a backend the guard must admit',
        sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
        expectFail: ['test/guard.test.mjs::allows user-defined backends'],
        expectPass: ['spec/extra.spec.mjs::extra'],
      }],
      label: 'routing-custom',
    });
    try {
      write(repo.root, 'harness/mutation/parse.mjs', `export { parse, canary } from ${JSON.stringify(NODE_TEST_MODULE)};\n`);
      git(repo.root, ['add', '-A']);
      git(repo.root, ['commit', '-qm', 'parser']);
      const result = await runCli(['run', '--all', '--json'], { cwd: repo.root });
      const report = JSON.parse(result.stdout);
      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.deepEqual(report.gates.baseline.groups.map((g) => [g.route, g.green]), [['unit', true], ['spec', true]]);
      assert.deepEqual(report.adapter.routes.map((r) => [r.name, r.runner]), [['unit', 'node-test'], ['spec', 'custom']]);
      const [mutant] = report.results;
      assert.equal(mutant.verdict, 'KILLED', mutant.detail);
      assert.deepEqual(mutant.narrowing.routes, ['unit', 'spec']);
      assert.deepEqual(mutant.groups.map((g) => [g.route, g.counts.failed]), [['unit', 1], ['spec', 0]]);
      // Invariant: each distinct narrow scope records every route it ran, with
      // that route's own counts and green reading.
      assert.equal(report.narrowBaselines.length, 1);
      assert.deepEqual(
        report.narrowBaselines[0].groups.map((g) => [g.route, g.runner, g.green, g.counts.ran]),
        [['unit', 'node-test', true, 3], ['spec', 'custom', true, 1]],
      );
      assert.equal(result.exitCode, ExitCode.CLEAN);
      assert.equal(repo.status(), '');
    } finally { repo.cleanup(); }
  });
});

describe('validate, routed', () => {
  // Invariants: an overlap, a route matching no file, and a vitest route blind
  // to its report dir are each warned per route; an unrouted ref is the same
  // problem `run` would refuse it with.
  test('warns route-overlap, per-route adapter-no-test-patterns and report-dir-unused; an unrouted ref is no-narrow-scope', async () => {
    const files = guardFiles();
    files['test/web-a.test.mjs'] = "import { test } from 'node:test';\ntest('w', () => {});\n";
    const repo = makeRepo({
      files,
      config: {
        baselineCommand: undefined,
        testCommand: undefined,
        runner: undefined,
        routes: [
          { name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test', baselineCommand: 'node --test', testCommand: 'node --test {tests}' },
          { name: 'web', tests: ['test/web-*.test.mjs'], runner: 'node-test', baselineCommand: 'node --test', testCommand: 'node --test {tests}' },
          { name: 'ui', tests: ['ui/**/*.test.ts'], runner: 'vitest', baselineCommand: 'npx vitest run', testCommand: 'npx vitest run {tests}' },
        ],
      },
      mutants: [{
        id: 'stray', invariant: 'i', whyNotEquivalent: 'w',
        sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
        expectFail: ['lib/elsewhere.test.mjs::x'],
      }],
      label: 'routing-validate',
    });
    try {
      const result = await runCli(['validate', '--json'], { cwd: repo.root });
      const report = JSON.parse(result.stdout);
      const issue = (code) => report.issues.filter((i) => i.code === code);

      const [overlap] = issue('route-overlap');
      assert.match(overlap.detail, /^test\/web-a\.test\.mjs matches the "tests" of routes "unit", "web"; the first, "unit", runs it/);
      assert.equal(overlap.severity, 'warning');

      const patterns = issue('adapter-no-test-patterns');
      assert.equal(patterns.length, 1);
      assert.match(patterns[0].detail, /^route "ui" \(vitest\) declares "tests" \(ui\/\*\*\/\*\.test\.ts\) that match no tracked file/);

      const [blind] = issue('report-dir-unused');
      assert.match(blind.detail, /^route "ui" \(vitest\) reads its results .* "baselineCommand" and "testCommand" never mention it/);

      const stray = report.mutants[0].issues.find((i) => i.code === 'no-narrow-scope');
      assert.equal(stray.severity, 'problem');
      assert.match(stray.detail, /lib\/elsewhere\.test\.mjs matches no route's tests/);
      assert.equal(result.exitCode, 4);
    } finally { repo.cleanup(); }
  });
});

describe('the mutant-run path, routed', () => {
  // Invariant: a narrowed scope where ANY route ran zero tests makes its
  // mutant ERROR scope-empty -- even though the other route's tests keep the
  // merged count above zero, which alone would read as scope-non-green.
  test('a narrow scope with one empty route is scope-empty, not scope-non-green', async () => {
    const files = guardFiles();
    files['spec/b.spec.mjs'] = "import { test } from 'node:test';\ntest('b', () => {});\n";
    // The spec route's baseline reports a test; its narrowed command none.
    files['tools/one.mjs'] = "process.stdout.write('ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\n');\n";
    files['tools/none.mjs'] = "process.stdout.write('ℹ tests 0\\nℹ pass 0\\nℹ fail 0\\n');\n";
    const repo = makeRepo({
      files,
      config: {
        baselineCommand: undefined,
        testCommand: undefined,
        runner: undefined,
        routes: [
          { name: 'unit', tests: ['test/*.test.mjs'], runner: 'node-test', baselineCommand: "node --test 'test/*.test.mjs'", testCommand: 'node --test {tests}' },
          { name: 'spec', tests: ['spec/*.spec.mjs'], runner: 'node-test', baselineCommand: 'node tools/one.mjs', testCommand: 'node tools/none.mjs {tests}' },
        ],
      },
      mutants: [{
        id: 'spans', invariant: 'i', whyNotEquivalent: 'w',
        sites: [{ file: 'src/guard.mjs', anchor: "return kind === 'user-defined';", replacement: 'return false;' }],
        expectFail: ['test/guard.test.mjs::allows user-defined backends'],
        expectPass: ['spec/b.spec.mjs::b'],
      }],
      label: 'routing-scope-empty',
    });
    try {
      const report = JSON.parse((await runCli(['run', '--all', '--json'], { cwd: repo.root })).stdout);
      assert.equal(report.gates.baseline.outcome, 'passed', report.gates.baseline.detail);
      assert.equal(report.narrowBaselines[0].counts.ran, 3, 'the merged count is not zero');
      const [mutant] = report.results;
      assert.equal(mutant.verdict, 'ERROR');
      assert.equal(mutant.reason, 'scope-empty');
      assert.match(mutant.detail, /route "spec": the command ran ZERO tests/);
    } finally { repo.cleanup(); }
  });
});
