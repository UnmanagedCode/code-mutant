// PARALLEL ISOLATION: no two mutants may ever occupy one workspace at the same
// time, observed MID-RUN rather than inferred from the final tree.
//
// The bug this pins (cards 2026-0010 / 2026-0029): the worker pool handed its
// callback the ITEM index and the runner picked `workspaces[index % length]`, so
// from item `jobs` onward a mutant could land in a copy whose previous occupant
// was still measuring. The final tree is no evidence either way -- every restore
// verifies its own bytes and passes -- so the only way to prove the property is to
// look while the runs are in flight.
//
// The interleave is forced with files, not sleeps: m0's mutant run blocks until
// m2's mutant run releases it, so a worker MUST come free and pick up a third
// item while m0 is still measuring. That is exactly the condition the old code
// mapped back onto m0's workspace.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { formatReport } from '../lib/report.mjs';
import { execute } from '../lib/runner.mjs';
import { makeRepo } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OCCUPANCY = path.join(HERE, 'helpers', 'occupancy-command.mjs');

const LETTERS = ['a', 'b', 'c'];

function moduleSource(letter) {
  return `export function value() {
  return 'ORIGINAL_${letter.toUpperCase()}';
}
`;
}

function testSource(letter) {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../src/${letter}.mjs';

test('${letter} keeps its value', () => { assert.equal(value(), 'ORIGINAL_${letter.toUpperCase()}'); });
`;
}

// Three modules, each with its own test file, so each mutant narrows to exactly
// one distinct scope -- which is what gives each concurrent run a distinct
// identity in the log and a distinct narrow baseline.
function threeModuleFiles() {
  const files = {};
  for (const letter of LETTERS) {
    files[`src/${letter}.mjs`] = moduleSource(letter);
    files[`test/${letter}.test.mjs`] = testSource(letter);
  }
  return files;
}

function mutantFor(letter) {
  return {
    id: `mutate-${letter}`,
    invariant: `${letter}'s value is pinned`,
    sites: [{
      file: `src/${letter}.mjs`,
      anchor: `'ORIGINAL_${letter.toUpperCase()}'`,
      replacement: `'MUTATED_${letter.toUpperCase()}'`,
    }],
    expectFail: [`test/${letter}.test.mjs::${letter} keeps its value`],
    expectPass: [],
    whyNotEquivalent: 'a different string is a different value',
    narrowTo: 'file',
  };
}

const SITES = LETTERS.map((l) => `src/${l}.mjs`);
const SCOPE = Object.fromEntries(LETTERS.map((l) => [l, `test/${l}.test.mjs`]));

function occupancyConfig(isolation, jobs) {
  return {
    // The baseline stays the REAL suite so the baseline and canary gates are
    // genuine; only the narrowed per-mutant command is faked.
    baselineCommand: 'node --test',
    testCommand: `node ${JSON.stringify(OCCUPANCY)} {tests}`,
    runner: 'node-test',
    isolation,
    jobs,
  };
}

// Runs the three mutants and returns the report plus the mid-run log. `block`
// and `release` name the scopes that coordinate the interleave; omit them for a
// serial run, where nothing would ever release the block.
async function runThree({ isolation, jobs, block = null, release = null, forceJobs = null }) {
  const repo = makeRepo({
    files: threeModuleFiles(), config: occupancyConfig(isolation, jobs), label: `occ-${isolation}`,
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-occ-'));
  const logFile = path.join(scratch, 'occupancy.jsonl');
  const releaseFile = path.join(scratch, 'release');
  const env = {
    CM_OCC_LOG: logFile,
    CM_OCC_SITES: SITES.join(','),
    CM_OCC_MARKER: 'MUTATED_',
    CM_OCC_BLOCK_SCOPE: block ?? '',
    CM_OCC_RELEASE_SCOPE: release ?? '',
    CM_OCC_RELEASE: block ? releaseFile : '',
    CM_OCC_DEADLINE_MS: '20000',
  };
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const config = loadConfig({ repoRoot: repo.root, overrides: { isolation } });
    if (forceJobs !== null) config.jobs = forceJobs;
    const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
    const report = await execute({
      config, adapter, mutants: LETTERS.map(mutantFor),
    });
    const records = existsSync(logFile)
      ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { report, records, repoRoot: repo.root };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    rmSync(scratch, { recursive: true, force: true });
    repo.cleanup();
  }
}

// Only the MUTANT runs matter here: phase A measures each narrow baseline with
// the same command against an unmutated tree, and those records are identified by
// carrying no mutated site.
function mutantRuns(records) {
  return records.filter((r) => r.mutated.length > 0);
}

// Walks the log in LINE ORDER -- the helper's documented authoritative ordering --
// and reports every enter that happened while another run was already open,
// tagged with whether the two shared a tree.
function overlaps(records) {
  const open = new Map(); // scope -> cwd
  const found = [];
  for (const r of mutantRuns(records)) {
    if (r.phase === 'enter') {
      for (const [otherScope, otherCwd] of open) {
        found.push({ scope: r.scope, cwd: r.cwd, otherScope, otherCwd, sameTree: otherCwd === r.cwd });
      }
      open.set(r.scope, r.cwd);
    } else if (r.phase === 'exit' || r.phase === 'timeout') {
      open.delete(r.scope);
    }
  }
  return found;
}

describe('parallel copy runs never share a workspace', () => {
  test('3 mutants at jobs=2 in copy mode: no two ever occupy one tree at once', async () => {
    const { report, records, repoRoot } = await runThree({
      isolation: 'copy', jobs: 2, block: SCOPE.a, release: SCOPE.c,
    });

    assert.deepEqual(
      records.filter((r) => r.phase === 'timeout'),
      [],
      'the forced interleave must have completed -- a timeout means the third mutant never ran',
    );
    const runs = mutantRuns(records);
    assert.equal(
      runs.filter((r) => r.phase === 'enter').length,
      3,
      'all three mutants must have measured with their mutation applied',
    );

    const found = overlaps(records);

    // (1) THE PROPERTY. Two mutants in one tree at once is the defect.
    assert.deepEqual(
      found.filter((o) => o.sameTree),
      [],
      'no two mutants may occupy the same workspace concurrently',
    );

    // (2) NON-VACUITY. Without this, (1) also passes if the pool silently
    // serialised and nothing was ever concurrent.
    assert.ok(
      found.some((o) => !o.sameTree),
      'two mutants must actually have been in flight at once, in different trees -- otherwise (1) proves nothing',
    );

    // (3) NO CROSS-CONTAMINATION, mid-run. The stronger form of (1): even if the
    // trees were distinct, a mutant must see ONLY its own mutation while it runs.
    for (const r of runs) {
      const own = `src/${r.scope.match(/test\/(\w)\.test\.mjs/)[1]}.mjs`;
      assert.deepEqual(
        r.mutated,
        [own],
        `during ${r.scope} exactly ${own} must be mutated, but ${JSON.stringify(r.mutated)} was`,
      );
    }

    // (4) Two distinct copies were used, neither of them the real tree.
    const trees = new Set(runs.map((r) => r.cwd));
    assert.equal(trees.size, 2, 'jobs=2 must have used exactly two copies');
    assert.ok(![...trees].includes(repoRoot), 'copy mode must never measure in the real tree');

    assert.equal(report.jobs, 2);

    // Whoever reads a puzzling verdict reads the report, not the warning that
    // scrolled past at config load, so the concurrent-suite caveat is repeated
    // here and names what makes a suite unsafe.
    const text = formatReport(report);
    assert.match(text, /your suite ran 2x concurrently/);
    assert.match(text, /fixed port/);
    assert.match(text, /preserve" paths are symlinked/);

    // The fake reports green unconditionally, so SURVIVED is the expected verdict
    // and says nothing about coverage. What matters is that NONE of them is ERROR:
    // the concurrency guards did not fire on a correctly isolated run.
    for (const result of report.results) {
      assert.equal(result.verdict, 'SURVIVED', `${result.id}: ${result.detail}`);
    }
  });
});

describe('in-place isolation stays clamped to a single workspace', () => {
  // No block/release here: with one workspace the release would never come.
  test('jobs=4 in config is clamped, and every mutant runs serially in the real tree', async () => {
    const { report, records, repoRoot } = await runThree({ isolation: 'in-place', jobs: 4 });

    assert.equal(report.jobs, 1);
    const runs = mutantRuns(records);
    assert.equal(runs.filter((r) => r.phase === 'enter').length, 3);
    for (const r of runs) assert.equal(r.cwd, repoRoot, 'in-place mutates the real tree, by definition');
    assert.deepEqual(overlaps(records), [], 'in-place must never run two mutants at once, in any tree');
    assert.equal(report.noTrace.ok, true);
  });

  test('a config.jobs the config layer never clamped is still clamped by the runner', async () => {
    // Mirrors test/gates.test.mjs: the runner owns the isolation-vs-concurrency
    // rule for its own execution and does not trust an upstream clamp to have run.
    const { report, records, repoRoot } = await runThree({ isolation: 'in-place', jobs: 1, forceJobs: 4 });

    assert.equal(report.jobs, 1);
    for (const r of mutantRuns(records)) assert.equal(r.cwd, repoRoot);
    assert.deepEqual(overlaps(records), [], 'one tree means one mutant at a time, whatever config.jobs claims');
  });
});
