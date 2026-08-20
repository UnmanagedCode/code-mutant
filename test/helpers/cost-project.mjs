// Fixture builder for the COST MODEL: a synthetic project big enough that "run
// the whole suite" and "run one test file" are separable measurements.
//
// WHAT NARROWING IS WORTH, and therefore what this fixture has to reproduce.
// `node --test` runs one child per available core, so a whole-suite run over F
// test files on C cores is roughly `ceil(F/C)` waves of one file. Narrowing to a
// single file saves those waves, so its payoff is ~FILES-PER-CORE. It is
// genuinely inert only in the degenerate `F < C` case -- one wave, nothing left
// to save but parent overhead, measured at 1.67x for 12 files on 16 cores. Real
// suites sit the other side of that line (the suite this fixture was built
// against: ~58s whole, ~0.7s for one file, ~83x).
//
// So `F >> C` is the regime worth measuring, and a 12-file fixture reproduces it
// with two levers -- file count is NOT one of them:
//
//  1. `--test-concurrency=1` on the measured command, which collapses the C cores
//     to one and puts 12 files into 12 waves. This is how the `F >> C` regime is
//     reached inside a small fixture, not a distortion of it. A caller measuring
//     the cost of scope must serialise the runner; `costConfig()` below does.
//  2. A FIXED-ITERATION hash loop per test file, so per-file work dominates child
//     spawn. Iterations, deliberately, and never a sleep: a sleep holds constant
//     while the runner's own cost scales with the machine, so the ratio a sleep
//     produces is an artifact of the machine it was tuned on. An iteration count
//     scales exactly as the runner does.
//
// Together, at the default below: whole suite 1.9s, one file 162ms, floor 63ms
// -- 11.7x raw, 18.5x net of the floor.
//
// `workIterations: 0` is the setting for the structural tests (test/timings.test.mjs):
// the ratio is a precondition of the MEASUREMENT, not of an assertion about which
// scope was measured, so those tests skip the work entirely and stay fast.

function moduleName(index) {
  return `m${String(index).padStart(2, '0')}`;
}

function source(name) {
  return `// One mutable invariant, and nothing else.
export function limit() {
  return 10;
}

export const label = '${name}';
`;
}

function tests(name, workIterations) {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limit, label } from '../src/${name}.mjs';

// Fixed-iteration work -- see test/helpers/cost-project.mjs for why this is not a sleep.
let hash = 7;
for (let i = 0; i < ${workIterations}; i += 1) hash = (hash * 31 + i) % 2147483647;

test('${name} limit is pinned', () => { assert.equal(limit(), 10); });
// The sibling in the same file: what makes narrowing granularity observable at
// all, the same role test/helpers/tmp-repo.mjs's GUARD_TESTS plays.
test('${name} label is pinned', () => { assert.equal(label, '${name}'); assert.ok(hash >= 0); });
`;
}

// `modules` src/test file pairs. Every module holds the same invariant shape, so
// a mutant against module i is like-for-like with a mutant against module j and
// the per-mutant cost is comparable across them.
export function costFiles({ modules = 12, workIterations = 5_000_000 } = {}) {
  const files = {};
  for (let i = 0; i < modules; i += 1) {
    const name = moduleName(i);
    files[`src/${name}.mjs`] = source(name);
    files[`test/${name}.test.mjs`] = tests(name, workIterations);
  }
  return files;
}

// The harness config a cost measurement needs: `copy` so nothing depends on the
// real tree, `jobs: 1` so a per-mutant number is a wall clock and not a share of
// one, and `--test-concurrency=1` on BOTH commands so the whole-suite and
// single-file measurements are the same runner mode (see lever 1 above).
export function costConfig(overrides = {}) {
  return {
    baselineCommand: 'node --test --test-concurrency=1',
    testCommand: 'node --test --test-concurrency=1 {tests}',
    isolation: 'copy',
    jobs: 1,
    ...overrides,
  };
}

// `n` mutants, ONE PER MODULE, so every mutant has a distinct narrow scope. That
// is the property the per-mutant cost question needs: N mutants sharing a scope
// would pay one narrow baseline between them and hide the per-scope cost.
export function costMutants(n) {
  return Array.from({ length: n }, (_unused, i) => {
    const name = moduleName(i);
    return {
      id: `limit-${name}`,
      invariant: `${name}.limit() returns 10`,
      sites: [{ file: `src/${name}.mjs`, anchor: 'return 10;', replacement: 'return 0;' }],
      expectFail: [`test/${name}.test.mjs::${name} limit is pinned`],
      expectPass: [`test/${name}.test.mjs::${name} label is pinned`],
      whyNotEquivalent: 'returning 0 is not the pinned limit',
    };
  });
}

// Two mutants naming the SAME test file, kept separate from costMutants so
// "distinct scope per mutant" stays true of that one. Same anchor, different
// replacements: two genuinely different mutations at one scope.
export function sharedScopeMutants() {
  const name = moduleName(0);
  return ['return 0;', 'return -1;'].map((replacement, i) => ({
    id: `shared-${i}`,
    invariant: `${name}.limit() returns 10 (variant ${i})`,
    sites: [{ file: `src/${name}.mjs`, anchor: 'return 10;', replacement }],
    expectFail: [`test/${name}.test.mjs::${name} limit is pinned`],
    expectPass: [`test/${name}.test.mjs::${name} label is pinned`],
    whyNotEquivalent: `${replacement} is not the pinned limit`,
  }));
}

// The control: the per-invocation startup floor P. One assertion, no work loop,
// so `node --test` over this file measures process startup and nothing else.
// Every cost number is reported both raw and net of P, so no conclusion can rest
// on startup.
export const TRIVIAL_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';

test('control', () => { assert.equal(1, 1); });
`;

// The 2026-0183 hang class, under control: a test file that REPORTS its result
// and still never lets its process exit, because a live handle is left open.
// Not a sleep -- a sleep ends, and the failure being reproduced is precisely the
// one where "the per-file abort fired but the file never reported".
//
// Conditional on the mutation, which is what makes it measurable: unmutated the
// handle is closed and the suite is green (so the baseline and narrow-baseline
// gates pass), and only the mutant run hangs. A file that hung unmutated would
// take the baseline gate down and no mutant would ever run.
export const HANGING_SOURCE = `export function leaks() {
  return false;
}
`;

export const HANGING_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { leaks } from '../src/hang.mjs';

test('does not leak a listening socket', () => {
  const server = net.createServer();
  server.listen(0);
  if (!leaks()) server.close();
  assert.equal(leaks(), false);
});
`;

export function hangingFiles() {
  return { 'src/hang.mjs': HANGING_SOURCE, 'test/hang.test.mjs': HANGING_TEST };
}

export function hangingMutant() {
  return {
    id: 'leaks-a-handle',
    invariant: 'the listening socket is always closed',
    sites: [{ file: 'src/hang.mjs', anchor: 'return false;', replacement: 'return true;' }],
    expectFail: ['test/hang.test.mjs::does not leak a listening socket'],
    expectPass: [],
    whyNotEquivalent: 'leaking the handle keeps the process alive after the test reports',
  };
}
