// THE NARROWING-POLICY TEST -- condition (ii), end to end.
//
// A mutant whose `expectFail` list OMITS a test in the same file that the mutation
// also breaks must read IMPRECISE, not KILLED.
//
// This is what pins the policy. Name-level narrowing would run only the listed
// tests, never see the omitted one fail, and report a confident KILLED for a
// mutant that is actually too broad. Both halves are asserted here: the default
// catches it, and the opt-in demonstrably does not -- which is exactly why
// name-level narrowing is not the default.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { execute } from '../lib/runner.mjs';
import { Reason, Verdict } from '../lib/classify.mjs';
import { makeRepo } from './helpers/tmp-repo.mjs';

// Both tests in this file assert on `enabled`, so disabling it breaks BOTH.
const SOURCE = `export function enabled(flag) {
  return flag === 'on';
}
`;

const TESTS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enabled } from '../src/flag.mjs';

test('on is enabled', () => { assert.equal(enabled('on'), true); });
test('ON is also checked elsewhere', () => { assert.equal(enabled('on'), true); });
test('off is not enabled', () => { assert.equal(enabled('off'), false); });
`;

const FILES = { 'src/flag.mjs': SOURCE, 'test/flag.test.mjs': TESTS };

// expectFail names only ONE of the two tests the mutation breaks.
const UNDERSTATED = {
  id: 'understated',
  invariant: 'the on-flag comparison is pinned',
  sites: [{ file: 'src/flag.mjs', anchor: "flag === 'on'", replacement: 'false' }],
  expectFail: ['test/flag.test.mjs::on is enabled'],
  expectPass: [],
  whyNotEquivalent: 'always returning false denies the enabled state entirely',
};

async function run(repo, mutants) {
  const config = loadConfig({ repoRoot: repo.root, overrides: { isolation: 'copy' } });
  const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
  return execute({ config, adapter, mutants });
}

describe('narrowing policy condition (ii)', () => {
  test('default file granularity reads IMPRECISE, not KILLED', async () => {
    const repo = makeRepo({ files: FILES, config: { isolation: 'copy' }, label: 'narrow-file' });
    try {
      const report = await run(repo, [UNDERSTATED]);
      const result = report.results[0];

      assert.equal(
        result.verdict,
        Verdict.IMPRECISE,
        `expected IMPRECISE but got ${result.verdict}: ${result.detail}`,
      );
      assert.equal(result.reason, Reason.EXTRA_FAILURES);
      assert.deepEqual(
        result.unexpectedFailures,
        ['test/flag.test.mjs::ON is also checked elsewhere'],
        'the omitted same-file failure must be surfaced',
      );
      assert.equal(result.narrowing.mode, 'file');
      // The scope really was the whole file -- that is what made the extra
      // failure observable at all.
      assert.match(result.narrowing.command, /test\/flag\.test\.mjs/);
      assert.ok(!result.narrowing.command.includes('--test-name-pattern'));
    } finally { repo.cleanup(); }
  });

  test('name-level narrowing would have reported a false KILLED -- why it is not the default', async () => {
    const repo = makeRepo({ files: FILES, config: { isolation: 'copy' }, label: 'narrow-names' });
    try {
      const report = await run(repo, [{ ...UNDERSTATED, id: 'opted-in', narrowTo: 'names' }]);
      const result = report.results[0];

      // Same mutant, same code, same broken tests -- but the omitted failure is
      // now outside the run scope, so the verdict flips to a confident kill.
      assert.equal(result.verdict, Verdict.KILLED);
      assert.equal(result.narrowing.mode, 'names');
      assert.match(result.narrowing.command, /--test-name-pattern/);
      assert.deepEqual(result.unexpectedFailures, []);
    } finally { repo.cleanup(); }
  });

  test('the report labels name-level narrowing so the weaker detection is visible', async () => {
    const repo = makeRepo({ files: FILES, config: { isolation: 'copy' }, label: 'narrow-label' });
    try {
      const report = await run(repo, [{ ...UNDERSTATED, id: 'opted-in', narrowTo: 'names' }]);
      const { formatReport } = await import('../lib/report.mjs');
      const text = formatReport(report);
      assert.match(text, /name-level narrowing/);
      assert.match(text, /IMPRECISE detection was limited/);
    } finally { repo.cleanup(); }
  });

  test('a complete expectFail list reads KILLED at file granularity', async () => {
    const repo = makeRepo({ files: FILES, config: { isolation: 'copy' }, label: 'narrow-complete' });
    try {
      const report = await run(repo, [{
        ...UNDERSTATED,
        id: 'complete',
        expectFail: [
          'test/flag.test.mjs::on is enabled',
          'test/flag.test.mjs::ON is also checked elsewhere',
        ],
      }]);
      assert.equal(report.results[0].verdict, Verdict.KILLED, report.results[0].detail);
      assert.equal(report.results[0].narrowing.mode, 'file');
    } finally { repo.cleanup(); }
  });

  test('a same-file test named in expectPass that breaks reads IMPRECISE', async () => {
    const repo = makeRepo({ files: FILES, config: { isolation: 'copy' }, label: 'narrow-pass' });
    try {
      const report = await run(repo, [{
        ...UNDERSTATED,
        id: 'broke-a-pass',
        expectFail: ['test/flag.test.mjs::on is enabled'],
        expectPass: ['test/flag.test.mjs::ON is also checked elsewhere'],
      }]);
      assert.equal(report.results[0].verdict, Verdict.IMPRECISE);
      assert.equal(report.results[0].reason, Reason.EXPECT_PASS_BROKE);
    } finally { repo.cleanup(); }
  });
});
