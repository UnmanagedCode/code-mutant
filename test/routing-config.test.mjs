// `routes` in config.json: one case per validation rule, plus the pin that a
// single-runner config means -- and fingerprints -- exactly what it did before.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError, loadConfig } from '../lib/config.mjs';
import { configFingerprint } from '../lib/fingerprint.mjs';

function withConfig(raw, body) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-routing-config-'));
  try {
    mkdirSync(path.join(root, 'harness', 'mutation'), { recursive: true });
    writeFileSync(path.join(root, 'harness', 'mutation', 'config.json'), JSON.stringify(raw));
    return body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const BACKEND = {
  name: 'backend', tests: ['tests/*.test.mjs'], runner: 'node-test',
  baselineCommand: 'node --test tests/', testCommand: 'node --test {tests}',
};
const FRONTEND = {
  name: 'frontend', tests: ['frontend/src/**/*.test.ts', 'frontend/src/**/*.test.tsx'], runner: 'vitest',
  baselineCommand: 'npx vitest run', testCommand: 'npx vitest run {tests}',
};

function rejects(raw, pattern) {
  withConfig(raw, (repoRoot) => {
    assert.throws(() => loadConfig({ repoRoot }), (err) => {
      assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err}`);
      assert.match(err.message, pattern);
      return true;
    });
  });
}

describe('routes: accepted shape', () => {
  test('a routed config normalises its routes and has no single runner or commands', () => {
    withConfig({ routes: [BACKEND, { ...FRONTEND, name: ' frontend ' }], isolation: 'copy', jobs: 2 }, (repoRoot) => {
      const config = loadConfig({ repoRoot });
      assert.equal(config.runner, null);
      assert.equal(config.baselineCommand, null);
      assert.equal(config.testCommand, null);
      assert.deepEqual(config.routes, [BACKEND, FRONTEND]);
      // Every other key stays top-level and shared.
      assert.equal(config.isolation, 'copy');
      assert.equal(config.jobs, 2);
    });
  });
});

describe('routes: each validation rule', () => {
  test('routes beside a top-level runner/command is refused, naming the keys to remove', () => {
    rejects({ routes: [BACKEND], runner: 'node-test', testCommand: 'x {tests}' },
      /config\.json: "routes" replaces the top-level "runner", "testCommand".*Remove/);
  });

  test('routes must be a non-empty array', () => {
    rejects({ routes: [] }, /"routes" must be a non-empty array of route objects/);
    rejects({ routes: { backend: BACKEND } }, /"routes" must be a non-empty array/);
  });

  test('a route must be an object', () => {
    rejects({ routes: ['backend'] }, /routes\[0\] must be an object/);
  });

  test('an unknown key is refused, listing the allowed keys -- the "test" for "tests" typo', () => {
    const { tests, ...rest } = BACKEND;
    rejects({ routes: [{ ...rest, test: tests }] },
      /routes\[0\] \("backend"\): unknown key\(s\) "test"; a route takes "name", "tests", "runner", "baselineCommand", "testCommand"/);
  });

  test('name must be a non-empty string', () => {
    rejects({ routes: [{ ...BACKEND, name: '' }] }, /routes\[0\]: "name" must be a non-empty string/);
  });

  test('name must match the route-name pattern', () => {
    rejects({ routes: [{ ...BACKEND, name: 'back end' }] }, /routes\[0\] \("back end"\): "name" must match/);
    rejects({ routes: [{ ...BACKEND, name: '-lead' }] }, /"name" must match/);
  });

  test('name must be unique', () => {
    rejects({ routes: [BACKEND, { ...FRONTEND, name: 'backend' }] },
      /routes\[1\] \("backend"\): "name" "backend" is used by an earlier route/);
  });

  test('tests must be a non-empty array of non-empty strings', () => {
    rejects({ routes: [{ ...BACKEND, tests: [] }] }, /routes\[0\] \("backend"\): "tests" must be a non-empty array/);
    rejects({ routes: [{ ...BACKEND, tests: 'tests/*.test.mjs' }] }, /"tests" must be a non-empty array/);
    rejects({ routes: [{ ...BACKEND, tests: ['ok/*.js', ' '] }] }, /"tests" must be a non-empty array of non-empty glob strings/);
  });

  test('a braced glob is refused, since the dialect would match it literally', () => {
    rejects({ routes: [{ ...FRONTEND, tests: ['frontend/src/**/*.test.{ts,tsx}'] }] },
      /"tests" pattern "frontend\/src\/\*\*\/\*\.test\.\{ts,tsx\}" uses braces/);
  });

  test('runner, baselineCommand and testCommand must be non-empty strings', () => {
    for (const field of ['runner', 'baselineCommand', 'testCommand']) {
      rejects({ routes: [{ ...BACKEND, [field]: ' ' }] }, new RegExp(`routes\\[0\\] \\("backend"\\): "${field}" must be a non-empty string`));
    }
  });

  test('testCommand must carry {tests}', () => {
    rejects({ routes: [{ ...BACKEND, testCommand: 'node --test' }] }, /"testCommand" must contain the \{tests\} placeholder/);
  });
});

describe('single-runner configs are unchanged', () => {
  // Invariant: single-runner meaning, and with it every cache and journal key,
  // is byte-for-byte what it was before routing existed.
  test('loads with no routes key, and fingerprints to the pinned canonical string', () => {
    withConfig({
      baselineCommand: 'npm test', testCommand: 'node --test {tests}', runner: 'node-test', preserve: ['node_modules'],
    }, (repoRoot) => {
      const config = loadConfig({ repoRoot });
      assert.equal('routes' in config, false);
      assert.equal(
        configFingerprint(config),
        '{"baselineCommand":"npm test","hang":{"factor":10,"floorMs":10000},"preserve":["node_modules"],'
        + '"runner":"node-test","setup":null,"teardown":null,"testCommand":"node --test {tests}","timeoutMs":120000}',
      );
    });
  });

  test('the missing-command errors are the ones a single-runner config always got', () => {
    rejects({ testCommand: 'x {tests}', runner: 'node-test' }, /config\.json: "baselineCommand" must be a non-empty string$/);
  });

  test('a routed config fingerprints its routes', () => {
    withConfig({ routes: [BACKEND] }, (repoRoot) => {
      const a = configFingerprint(loadConfig({ repoRoot }));
      withConfig({ routes: [{ ...BACKEND, tests: ['other/*.test.mjs'] }] }, (other) => {
        assert.notEqual(configFingerprint(loadConfig({ repoRoot: other })), a);
      });
    });
  });
});
