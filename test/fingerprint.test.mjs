// The shared fingerprint helpers, pinned at the one place a change to them is
// silently expensive.
//
// `canonical`, `sha256` and `configFingerprint` were lifted out of
// lib/journal.mjs so the gate cache could share them. A lift that changed the
// canonical string by one byte would change every journal key, so every journal
// on every open review loop would stop matching and a resumed run would silently
// re-measure everything -- the exact cost resume exists to avoid, with no error
// to notice. The golden digest below was computed against the pre-lift code.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canonical, configFingerprint } from '../lib/fingerprint.mjs';
import { journalKey } from '../lib/journal.mjs';

const GOLDEN_INPUT = {
  mutatedSha: '0123456789abcdef0123456789abcdef01234567',
  config: {
    baselineCommand: 'npm test',
    testCommand: 'node --test {tests}',
    runner: 'node-test',
    timeoutMs: 120_000,
    hang: { factor: 10, floorMs: 10_000 },
    setup: null,
    teardown: null,
    preserve: ['node_modules'],
    // Present on the real resolved config and deliberately outside the
    // fingerprint: a key that picked these up would invalidate every journal on
    // a `--jobs` flag or a checkout at a different path.
    repoRoot: '/ignored',
    jobs: 99,
  },
  adapter: { name: 'node-test', grade: 'counted', modulePath: null },
  isolation: 'in-place',
  jobs: 1,
  learn: false,
};

// Computed from lib/journal.mjs BEFORE canonical/sha256/configFingerprint moved
// to lib/fingerprint.mjs.
const GOLDEN_KEY = '5bea407cbfa772d6aaeb353e075acca5';

describe('shared fingerprints', () => {
  test('G0: the lift to lib/fingerprint.mjs left journalKey byte-identical', () => {
    assert.equal(journalKey(GOLDEN_INPUT), GOLDEN_KEY);
  });

  test('G0b: configFingerprint reads what is measured and nothing else', () => {
    const base = GOLDEN_INPUT.config;
    // The excluded fields, moved: same fingerprint, so no journal and no cached
    // gate is invalidated by a checkout path or a concurrency flag.
    assert.equal(
      configFingerprint({ ...base, repoRoot: '/elsewhere', jobs: 1, baseBranch: 'main' }),
      configFingerprint(base),
    );
    // And one included field, moved: a different fingerprint.
    assert.notEqual(configFingerprint({ ...base, baselineCommand: 'npm run other' }), configFingerprint(base));
  });

  test('G0c: canonical sorts keys at every level, so field order is not a change', () => {
    assert.equal(
      canonical({ b: 1, a: { d: [1, 2], c: null } }),
      canonical({ a: { c: undefined, d: [1, 2] }, b: 1 }),
    );
    assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  });
});
