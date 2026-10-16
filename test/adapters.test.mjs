// Adapters pinned to CAPTURED REAL OUTPUT, not invented samples.
//
// Parsers are the one place project-facing behaviour is inferred from text, so
// every expectation here is checked against output a real toolchain actually
// produced -- see test/fixtures/PROVENANCE.md for versions and commands.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdapterError, SHIPPED_ADAPTERS, loadAdapter, missingCanaryExports,
} from '../lib/adapters/index.mjs';
import { stripAnsi } from '../lib/adapters/common.mjs';
import { Reason, Verdict, classify } from '../lib/classify.mjs';
import { isGreen } from '../lib/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function fixture(adapter, name) {
  const base = path.join(FIXTURES, adapter, name);
  assert.ok(existsSync(`${base}.meta.json`), `missing captured fixture ${adapter}/${name}`);
  const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'));
  return {
    meta,
    stdout: readFileSync(`${base}.stdout.txt`, 'utf8'),
    stderr: readFileSync(`${base}.stderr.txt`, 'utf8'),
    // What the command wrote into its report dir, keyed by basename -- the map
    // the runner hands parse() as `context.reports`.
    reports: Object.fromEntries((meta.reports ?? []).map((name) => [
      name, readFileSync(`${base}.report.${name}`, 'utf8'),
    ])),
  };
}

// `meta.cwd` is the directory the capture ran in -- the workspace root the
// runner would pass, against which vitest's absolute paths are relativised.
function parseFixture(adapterName, caseName) {
  const adapter = SHIPPED_ADAPTERS[adapterName];
  const { stdout, stderr, meta, reports } = fixture(adapterName, caseName);
  return { result: adapter.parse(stdout, stderr, meta.exitCode, { cwd: meta.cwd, reports }), meta };
}

// Every counted case across every shipped adapter, with the numbers the real run
// produced. `ran` includes skipped, because it answers "did the command execute
// anything at all" -- the question that stops a zero-test scope reading SURVIVED.
const EXPECTATIONS = {
  'node-test': {
    pass: { passed: 2, failed: 0, skipped: 0, ran: 2, compileError: false, failedTests: [] },
    fail: {
      passed: 1, failed: 2, skipped: 0, ran: 3, compileError: false,
      // The failing-tests summary block alone only carries leaf names; the
      // nested one's full path comes from cross-referencing the inline block.
      failedTests: ['test/math.test.mjs::subtracts', 'test/math.test.mjs::nested > inner failure'],
    },
    skip: { passed: 1, failed: 0, skipped: 1, ran: 3, compileError: false, failedTests: [] },
    'compile-error': { passed: 0, failed: 1, skipped: 0, ran: 1, compileError: true },
  },
  pytest: {
    pass: { passed: 2, failed: 0, skipped: 0, ran: 2, compileError: false, failedTests: [] },
    fail: {
      passed: 1, failed: 2, skipped: 0, ran: 3, compileError: false,
      failedTests: ['tests/test_math.py::test_subtracts', 'tests/test_math.py::TestGroup::test_inner'],
    },
    // 1 passed, 1 skipped, 1 xfailed -- xfail counts toward `ran` but is not a failure.
    skip: { passed: 1, failed: 0, skipped: 1, ran: 3, compileError: false, failedTests: [] },
    // A collection error means zero tests ran, even though the banner's error
    // count would otherwise sum into `ran` as though something had.
    'compile-error': { passed: 0, failed: 1, skipped: 0, ran: 0, compileError: true },
  },
  vitest: {
    pass: { passed: 2, failed: 0, skipped: 0, ran: 2, compileError: false, failedTests: [] },
    fail: {
      passed: 1, failed: 2, skipped: 0, ran: 3, compileError: false,
      // ancestorTitles + title, joined ' > ': the nested path a reviewer writes.
      failedTests: ['test/math.test.js::subtracts', 'test/math.test.js::nested > inner failure'],
    },
    // skipped + todo are both non-signal outcomes and are counted together.
    skip: { passed: 1, failed: 0, skipped: 2, ran: 3, compileError: false, failedTests: [] },
    // The file that failed to transform is one file-level failure, named by the
    // file alone; the passing file beside it still counts.
    'compile-error': {
      passed: 1, failed: 1, skipped: 0, ran: 2, compileError: true, failedTests: ['test/broken.test.js'],
    },
    'console-noise': {
      passed: 2, failed: 1, skipped: 0, ran: 3, compileError: false,
      failedTests: ['test/math.test.js::nested > inner failure'],
    },
    large: {
      passed: 2000, failed: 1, skipped: 0, ran: 2001, compileError: false,
      failedTests: ['test/math.test.js::the one failure'],
    },
    'no-files': { passed: 0, failed: 0, skipped: 0, ran: 0, compileError: false, failedTests: [] },
    'unhandled-error': { passed: 2, failed: 0, skipped: 0, ran: 2, compileError: false, failedTests: [] },
  },
  dotnet: {
    pass: { passed: 2, failed: 0, skipped: 0, ran: 2, compileError: false, failedTests: [] },
    fail: {
      passed: 1, failed: 2, skipped: 0, ran: 3, compileError: false,
      // No file -- dotnet's output carries none, so references are fully-qualified names.
      failedTests: ['proj.UnitTest1.Subtracts', 'proj.UnitTest1.Throws'],
    },
    skip: { passed: 1, failed: 0, skipped: 1, ran: 2, compileError: false, failedTests: [] },
    'compile-error': { passed: 0, failed: 0, skipped: 0, ran: 0, compileError: true },
  },
};

for (const [adapterName, cases] of Object.entries(EXPECTATIONS)) {
  describe(`${adapterName} adapter (captured output)`, () => {
    for (const [caseName, expected] of Object.entries(cases)) {
      test(`parses the real ${caseName} output`, () => {
        const { result, meta } = parseFixture(adapterName, caseName);
        assert.equal(result.grade, 'counted');
        assert.equal(result.passed, expected.passed, `passed (from ${meta.tool} ${meta.version})`);
        assert.equal(result.failed, expected.failed, 'failed');
        assert.equal(result.skipped, expected.skipped, 'skipped');
        assert.equal(result.ran, expected.ran, 'ran');
        assert.equal(result.compileError, expected.compileError, 'compileError');
        if (expected.failedTests) {
          assert.deepEqual(result.failedTests.map((t) => t.id), expected.failedTests);
        }
      });
    }

    test('the fixture records a real captured exit code', () => {
      for (const caseName of Object.keys(cases)) {
        const { meta } = fixture(adapterName, caseName);
        assert.equal(typeof meta.exitCode, 'number');
        assert.equal(meta.capturedBy, 'test/fixtures/capture/capture.sh');
        if (caseName === 'pass' || caseName === 'skip') assert.equal(meta.exitCode, 0);
        else assert.notEqual(meta.exitCode, 0, `${caseName} should have a non-zero exit`);
      }
    });
  });
}

describe('vitest JSON report file', () => {
  const vitest = SHIPPED_ADAPTERS.vitest;
  const parseWith = (report, exitCode, cwd, stdout = '') => vitest.parse(
    stdout, '', exitCode, { cwd, reports: report === null ? {} : { 'vitest.json': report } },
  );

  // Invariant: test-emitted stdout -- console output, raw writes with no
  // newline, a decoy report prefix -- is irrelevant to the parse.
  test('stdout noise cannot change the parsed report', () => {
    const { stdout, meta, reports } = fixture('vitest', 'console-noise');
    assert.ok(stdout.includes('module-scope-no-newline') && stdout.includes('{"numTotalTestSuites":1}'),
      'the capture really carries noise and a decoy on stdout');
    assert.deepEqual(
      parseWith(reports['vitest.json'], meta.exitCode, meta.cwd, stdout),
      parseWith(reports['vitest.json'], meta.exitCode, meta.cwd, ''),
    );
  });

  // Invariant: a large report file parses intact.
  test('a report far larger than a pipe buffer parses intact', () => {
    const { reports } = fixture('vitest', 'large');
    assert.ok(Buffer.byteLength(reports['vitest.json']) > 65_536, 'the report is over 64 KiB');
    const { result } = parseFixture('vitest', 'large');
    assert.equal(result.diagnostic, null);
    assert.equal(result.ran, 2001);
  });

  // Invariant: neither an empty run nor a run that exits 1 with every test
  // passing can read as green or SURVIVED.
  test('a filter matching no file ran zero tests and is never green', () => {
    const { result, meta } = parseFixture('vitest', 'no-files');
    assert.equal(isGreen({ run: { exitCode: meta.exitCode }, parsed: result }), false);
  });

  test('an unhandled error with every test passing is ERROR unexplained-exit, never SURVIVED', () => {
    const { result, meta } = parseFixture('vitest', 'unhandled-error');
    const verdict = classify({ run: { exitCode: meta.exitCode }, parsed: result, expectFail: ['test/math.test.js::adds'] });
    assert.equal(verdict.verdict, Verdict.ERROR);
    assert.equal(verdict.reason, Reason.UNEXPLAINED_EXIT);
  });

  // Invariant: a command that writes no report -- the text reporter, or a JSON
  // reporter aimed anywhere but the report dir -- fails loudly, naming the flags.
  test('no report file is zero tests plus a diagnostic naming the exact flags', () => {
    const text = ' RUN  v5.0.5 /repo\n\n ✓ test/math.test.js (2 tests) 2ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n';
    const result = parseWith(null, 0, '/repo', text);
    assert.equal(result.ran, 0);
    assert.ok(result.diagnostic.includes('--reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"'), result.diagnostic);
    assert.equal(isGreen({ run: { exitCode: 0 }, parsed: result }), false);
  });

  describe('a damaged report never yields a graded verdict from it', () => {
    const { meta, reports } = fixture('vitest', 'fail');
    const report = reports['vitest.json'];
    const expectFail = ['test/math.test.js::subtracts', 'test/math.test.js::nested > inner failure'];
    const damaged = (from, to) => {
      assert.ok(report.includes(from), `fixture carries ${from}`);
      return report.replace(from, to);
    };

    test('the undamaged report grades KILLED (the control)', () => {
      const parsed = parseWith(report, meta.exitCode, meta.cwd);
      assert.equal(classify({ run: { exitCode: meta.exitCode }, parsed, expectFail }).verdict, Verdict.KILLED);
    });

    test('truncated JSON is unreadable', () => {
      const parsed = parseWith(report.slice(0, Math.floor(report.length / 2)), meta.exitCode, meta.cwd);
      assert.equal(parsed.ran, 0);
      assert.match(parsed.diagnostic, /Vitest JSON report is unreadable/);
      assert.equal(classify({ run: { exitCode: meta.exitCode }, parsed, expectFail }).verdict, Verdict.ERROR);
    });

    test('a byte injected between tokens is unreadable', () => {
      const parsed = parseWith(damaged('"numFailedTests":2,', '"numFailedTests":2,X'), meta.exitCode, meta.cwd);
      assert.equal(parsed.ran, 0);
    });

    test('a byte injected inside a status string is unreadable', () => {
      const parsed = parseWith(damaged('"status":"failed","title":"subtracts"', '"status":"faXiled","title":"subtracts"'), meta.exitCode, meta.cwd);
      assert.equal(parsed.ran, 0);
      assert.match(parsed.diagnostic, /unreadable: .*unknown shape or status/);
    });

    test('a status flipped to another valid status fails the counter check', () => {
      const parsed = parseWith(damaged('"status":"failed","title":"subtracts"', '"status":"passed","title":"subtracts"'), meta.exitCode, meta.cwd);
      assert.equal(parsed.ran, 0);
      assert.match(parsed.diagnostic, /numPassedTests is 1 but the report lists 2/);
    });

    test('bytes injected into a failing title grade IMPRECISE, never KILLED or SURVIVED', () => {
      const parsed = parseWith(damaged('"title":"inner failure"', '"title":"inner fXailure"'), meta.exitCode, meta.cwd);
      const verdict = classify({ run: { exitCode: meta.exitCode }, parsed, expectFail }).verdict;
      assert.ok([Verdict.IMPRECISE, Verdict.ERROR].includes(verdict), `got ${verdict}`);
    });
  });

  // Invariant: ids are repo-relative against the workspace the command ran in --
  // which in copy mode is the copy, not the real tree.
  test('absolute file paths are relativised against context.cwd only', () => {
    const { meta, reports } = fixture('vitest', 'fail');
    const ids = (cwd) => parseWith(reports['vitest.json'], meta.exitCode, cwd).failedTests.map((t) => t.id);
    assert.deepEqual(ids(meta.cwd), ['test/math.test.js::subtracts', 'test/math.test.js::nested > inner failure']);
    assert.deepEqual(ids(undefined), [
      `${meta.cwd}/test/math.test.js::subtracts`, `${meta.cwd}/test/math.test.js::nested > inner failure`,
    ]);
    assert.deepEqual(ids('/some/other/root'), ids(undefined));
    assert.deepEqual(parseWith(reports['vitest.json'], meta.exitCode, meta.cwd).files, ['test/math.test.js']);
  });

  test('the names-mode -t pattern selects the named test and not a sibling that extends it', () => {
    const command = vitest.substitute({
      scopes: ['test/a.test.js'], refs: ['test/a.test.js::nested > inner failure'], mode: 'names',
    });
    const pattern = new RegExp(command.match(/-t '(.*)'$/)[1]);
    assert.ok(pattern.test('nested > inner failure'));
    assert.ok(!pattern.test('nested > inner failure two'));
    assert.ok(!pattern.test('nested inner failure'));
  });
});

describe('node-test nested failure paths', () => {
  test('two describes with the same leaf name do not collide to one id', () => {
    // Hand-authored in the exact spec-reporter shape (verified against a real
    // `node --test` run), not a new captured fixture: the inline block reports
    // each result twice, and two failures sharing a leaf name need distinct
    // (name, duration) pairs to disambiguate -- exactly what a real run gives.
    const stdout = [
      '✔ adds (0.463275ms)',
      '▶ group a',
      '  ✖ inner failure (0.432341ms)',
      '  ▶ nested deeper',
      '    ✖ inner failure (0.112052ms)',
      '  ✖ nested deeper (0.198754ms)',
      '✖ group a (1.289176ms)',
      '▶ group b',
      '  ✖ inner failure (0.113991ms)',
      '✖ group b (0.19641ms)',
      'ℹ tests 4',
      'ℹ suites 3',
      'ℹ pass 1',
      'ℹ fail 3',
      'ℹ cancelled 0',
      'ℹ skipped 0',
      'ℹ todo 0',
      'ℹ duration_ms 40.960716',
      '',
      '✖ failing tests:',
      '',
      'test at test/math.test.mjs:6:3',
      '✖ inner failure (0.432341ms)',
      '',
      'test at test/math.test.mjs:8:5',
      '✖ inner failure (0.112052ms)',
      '',
      'test at test/math.test.mjs:12:3',
      '✖ inner failure (0.113991ms)',
      '',
    ].join('\n');

    const result = SHIPPED_ADAPTERS['node-test'].parse(stdout, '', 1);
    assert.deepEqual(result.failedTests.map((t) => t.id), [
      'test/math.test.mjs::group a > inner failure',
      'test/math.test.mjs::group a > nested deeper > inner failure',
      'test/math.test.mjs::group b > inner failure',
    ]);
  });

  test('a missing inline correlate falls back to the leaf name rather than guessing', () => {
    const stdout = [
      'ℹ tests 1',
      'ℹ pass 0',
      'ℹ fail 1',
      '',
      '✖ failing tests:',
      '',
      'test at test/math.test.mjs:3:1',
      '✖ orphaned (1ms)',
      '',
    ].join('\n');

    const result = SHIPPED_ADAPTERS['node-test'].parse(stdout, '', 1);
    assert.deepEqual(result.failedTests.map((t) => t.id), ['test/math.test.mjs::orphaned']);
  });
});

describe('no cargo adapter ships', () => {
  test('cargo is absent by decision, not by omission', () => {
    assert.equal(SHIPPED_ADAPTERS.cargo, undefined);
    assert.deepEqual(
      Object.keys(SHIPPED_ADAPTERS).sort(),
      ['dotnet', 'exit-code', 'node-test', 'pytest', 'vitest'],
    );
    // No unproven fixture left lying around to imply otherwise.
    assert.equal(existsSync(path.join(FIXTURES, 'cargo')), false);
  });
});

describe('exit-code adapter', () => {
  test('reports no counts and never guesses compileError', () => {
    const adapter = SHIPPED_ADAPTERS['exit-code'];
    assert.equal(adapter.grade, 'exit-code');
    for (const code of [0, 1, 2, 127]) {
      const result = adapter.parse('anything', 'anything', code);
      assert.equal(result.grade, 'exit-code');
      assert.equal(result.passed, null);
      assert.equal(result.failed, null);
      assert.equal(result.ran, null);
      assert.deepEqual(result.failedTests, []);
      // Guessing this from an exit code would fabricate precision the grade
      // explicitly does not have.
      assert.equal(result.compileError, false);
    }
  });

  test('cannot name-filter and substitutes nothing', () => {
    const adapter = SHIPPED_ADAPTERS['exit-code'];
    assert.equal(adapter.canNameFilter, false);
    assert.equal(adapter.substitute({ scopes: ['a'], refs: ['a'], mode: 'file' }), '');
    assert.equal(adapter.canary(), null);
  });
});

describe('scope and substitution', () => {
  test('file-based adapters scope to the file', () => {
    for (const name of ['node-test', 'pytest', 'vitest']) {
      assert.equal(SHIPPED_ADAPTERS[name].scopeOf('test/a.test.mjs::some name'), 'test/a.test.mjs');
      assert.equal(SHIPPED_ADAPTERS[name].scopeOf('test/a.test.mjs'), 'test/a.test.mjs');
    }
  });

  test('dotnet scopes to the declaring type, since its output has no file', () => {
    assert.equal(SHIPPED_ADAPTERS.dotnet.scopeOf('proj.UnitTest1.Subtracts'), 'proj.UnitTest1');
  });

  test('file-mode substitution quotes paths', () => {
    assert.equal(
      SHIPPED_ADAPTERS['node-test'].substitute({ scopes: ['test/a b.test.mjs'], refs: [], mode: 'file' }),
      "'test/a b.test.mjs'",
    );
  });

  test('name-mode substitution uses each runner native filter', () => {
    // Order matters for node: it stops consuming its own flags at the first
    // positional, so a pattern placed after the file filters nothing at all.
    assert.equal(
      SHIPPED_ADAPTERS['node-test'].substitute({
        scopes: ['test/a.test.mjs'], refs: ['test/a.test.mjs::one'], mode: 'names',
      }),
      "--test-name-pattern '^(?:one)$' 'test/a.test.mjs'",
    );
    assert.equal(
      SHIPPED_ADAPTERS.pytest.substitute({
        scopes: ['tests/t.py'], refs: ['tests/t.py::test_one'], mode: 'names',
      }),
      "'tests/t.py::test_one'",
    );
    // Vitest matches -t against its ' > '-joined fullTestName, so the ref's own
    // path goes through verbatim, escaped and anchored.
    assert.equal(
      SHIPPED_ADAPTERS.vitest.substitute({
        scopes: ['test/a.test.js'], refs: ['test/a.test.js::nested > inner failure', 'test/a.test.js::one'], mode: 'names',
      }),
      "'test/a.test.js' -t '^(?:nested > inner failure|one)$'",
    );
    assert.equal(
      SHIPPED_ADAPTERS.dotnet.substitute({
        scopes: ['proj.T'], refs: ['proj.T.One'], mode: 'names',
      }),
      "--filter 'FullyQualifiedName=proj.T.One'",
    );
  });
});

describe('canary synthesis', () => {
  test('each counted adapter appends a named failing test', () => {
    const targets = {
      'node-test': 'test/a.test.mjs',
      pytest: 'tests/test_a.py',
      vitest: 'test/a.test.js',
      dotnet: 'UnitTest1.cs',
    };
    for (const [name, file] of Object.entries(targets)) {
      const source = 'original content\n';
      const canary = SHIPPED_ADAPTERS[name].canary(source, { file });
      assert.ok(canary, `${name} should synthesise a canary`);
      assert.ok(canary.content.startsWith(source), `${name} must append, not replace`);
      assert.ok(canary.content.length > source.length);
      assert.ok(canary.testId, `${name} canary needs a test id`);
      assert.equal(typeof canary.matches, 'function');
    }
  });

  test('node-test sniffs CommonJS rather than assuming ESM', () => {
    const cjs = SHIPPED_ADAPTERS['node-test'].canary("const x = require('node:fs');\n", { file: 'test/a.test.js' });
    assert.match(cjs.content, /require\('node:test'\)/);
    const esm = SHIPPED_ADAPTERS['node-test'].canary("import fs from 'node:fs';\n", { file: 'test/a.test.mjs' });
    assert.match(esm.content, /import \{ test as __codeMutantCanary \}/);
  });

  test('a source file with no trailing newline still yields valid output', () => {
    for (const name of ['node-test', 'pytest', 'vitest', 'dotnet']) {
      const canary = SHIPPED_ADAPTERS[name].canary('no trailing newline', { file: 'x' });
      assert.match(canary.content, /^no trailing newline\n/);
    }
  });
});

describe('custom parser loading', () => {
  function withCustom(body) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-custom-'));
    writeFileSync(path.join(dir, 'parse.mjs'), body);
    return dir;
  }

  test('loads parse.mjs from beside config.json', async () => {
    const dir = withCustom(`
      export function parse(stdout, stderr, exitCode) {
        return { grade: 'counted', passed: 7, failed: 1, skipped: 0, ran: 8,
                 failedTests: [{ file: 'f', name: 'n', id: 'f::n' }], compileError: false, counts: {} };
      }
    `);
    try {
      const adapter = await loadAdapter('custom', { configDir: dir });
      assert.equal(adapter.name, 'custom');
      const result = adapter.parse('', '', 1);
      assert.equal(result.passed, 7);
      assert.deepEqual(result.failedTests.map((t) => t.id), ['f::n']);
      // Defaults it did not provide, rather than invented behaviour.
      assert.equal(adapter.canNameFilter, false);
      // ABSENT, not a stub returning null: the absence is what the counted-grade
      // canary prerequisite reads, and a stub would hide it.
      assert.equal(adapter.canary, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing parse.mjs is a clear error, not a silent fallback', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-custom-'));
    try {
      await assert.rejects(() => loadAdapter('custom', { configDir: dir }), AdapterError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a parse.mjs without parse() is rejected', async () => {
    const dir = withCustom('export const nope = 1;\n');
    try {
      await assert.rejects(() => loadAdapter('custom', { configDir: dir }), /must export a function named "parse\(/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a parse.mjs returning junk is rejected rather than trusted', async () => {
    const dir = withCustom('export function parse() { return undefined; }\n');
    try {
      const adapter = await loadAdapter('custom', { configDir: dir });
      assert.throws(() => adapter.parse('', '', 0), /expected an object/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('parse() returning grade "exit-code" does NOT make the adapter exit-code grade', async () => {
    // The adapter's grade comes from the MODULE-level export; the parse() return
    // field is per-verdict. A parser that only sets the latter stays counted
    // grade and needs a canary() -- documented in mutants.schema.md Appendix B
    // because it is otherwise a silent trap.
    const dir = withCustom(`
      export function parse() {
        return { grade: 'exit-code', passed: null, failed: null, skipped: null, ran: null,
                 failedTests: [], compileError: false, counts: {} };
      }
    `);
    try {
      const adapter = await loadAdapter('custom', { configDir: dir });
      assert.equal(adapter.grade, 'counted');
      assert.deepEqual(missingCanaryExports(adapter), ['canary(source, { file })']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe('missingCanaryExports', () => {
    test('a bare counted parser is missing canary()', async () => {
      const dir = withCustom('export function parse() { return { failedTests: [] }; }\n');
      try {
        const adapter = await loadAdapter('custom', { configDir: dir });
        assert.deepEqual(missingCanaryExports(adapter), ['canary(source, { file })']);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('an exit-code parser is missing nothing -- its canary is synthesised by the gate', async () => {
      const dir = withCustom(
        "export const grade = 'exit-code';\nexport function parse() { return { failedTests: [] }; }\n",
      );
      try {
        const adapter = await loadAdapter('custom', { configDir: dir });
        assert.equal(adapter.grade, 'exit-code');
        assert.deepEqual(missingCanaryExports(adapter), []);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('no shipped adapter trips it', async () => {
      for (const runner of Object.keys(SHIPPED_ADAPTERS)) {
        const adapter = await loadAdapter(runner, { configDir: '/tmp' });
        assert.deepEqual(missingCanaryExports(adapter), [], `${runner} must never be refused`);
      }
    });
  });

  test('an unknown runner names the shipped adapters', async () => {
    await assert.rejects(
      () => loadAdapter('cargo', { configDir: '/tmp' }),
      /unknown runner "cargo".*node-test, pytest, vitest, dotnet, exit-code.*custom/s,
    );
  });
});

describe('stripAnsi', () => {
  test('removes escape sequences but leaves real brackets alone', () => {
    assert.equal(stripAnsi('[31mred[0m'), 'red');
    // A runner's real bracketed output; eating the brackets would corrupt it.
    assert.equal(stripAnsi(' FAIL  f.js [ f.js ]'), ' FAIL  f.js [ f.js ]');
  });
});
