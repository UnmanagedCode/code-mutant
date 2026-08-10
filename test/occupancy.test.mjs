// The three isolation-integrity primitives, at their own boundaries.
//
// These are the belt to the ordinal fix's braces. The point of testing them
// separately is that once the ordinal is right they should NEVER fire through the
// runner -- so the runner is not where their behaviour can be pinned.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OccupancyError, createOccupancy } from '../lib/occupancy.mjs';
import { captureSnapshot } from '../lib/snapshot.mjs';
import { pool } from '../lib/runner.mjs';
import { runMutant } from '../lib/mutant-run.mjs';
import { resolveSites } from '../lib/sites.mjs';

function scratch(label) {
  return mkdtempSync(path.join(os.tmpdir(), `code-mutant-occ-unit-${label}-`));
}

describe('pool hands its callback a worker ordinal, not the item index', () => {
  test('ordinals stay within the pool width and are never held by two live calls at once', async () => {
    const live = new Set();
    const seen = [];
    let sawOrdinalDifferFromIndex = false;

    await pool([0, 1, 2, 3, 4], 2, async (item, index, ordinal) => {
      assert.ok(ordinal < 2, `ordinal ${ordinal} is outside the pool width`);
      assert.equal(
        live.has(ordinal),
        false,
        `ordinal ${ordinal} was already in use by a live call -- an ordinal must identify ONE worker`,
      );
      live.add(ordinal);
      if (ordinal !== index) sawOrdinalDifferFromIndex = true;
      seen.push({ index, ordinal });
      await new Promise((resolve) => { setImmediate(resolve); });
      live.delete(ordinal);
      return item;
    });

    assert.equal(seen.length, 5);
    // The whole defect in one assertion: from item `width` onward the item index
    // is NOT a worker ordinal, so a callback that used the index as one would be
    // addressing a worker that is busy.
    assert.ok(
      sawOrdinalDifferFromIndex,
      'with 5 items over 2 workers the ordinal must differ from the item index somewhere',
    );
  });

  test('results stay in item order regardless of which worker produced them', async () => {
    const results = await pool([10, 20, 30, 40], 3, async (item, index) => `${index}:${item}`);
    assert.deepEqual(results, ['0:10', '1:20', '2:30', '3:40']);
  });
});

describe('occupancy: exclusive claim', () => {
  test('a second claim while one is held is refused, naming both occupants', () => {
    const occupancy = createOccupancy('/tmp/example');
    occupancy.claim('mutant-a');
    assert.throws(() => occupancy.claim('mutant-b'), (err) => {
      assert.ok(err instanceof OccupancyError);
      assert.match(err.message, /mutant-a/);
      assert.match(err.message, /mutant-b/);
      return true;
    });
  });

  test('release frees the workspace for the next mutant -- serial reuse is the normal path', () => {
    const occupancy = createOccupancy('/tmp/example');
    const lease = occupancy.claim('mutant-a');
    lease.release();
    assert.equal(occupancy.holder(), null);
    assert.doesNotThrow(() => occupancy.claim('mutant-b'));
    assert.equal(occupancy.holder(), 'mutant-b');
  });

  test('releasing twice cannot evict a later occupant', () => {
    const occupancy = createOccupancy('/tmp/example');
    const first = occupancy.claim('mutant-a');
    first.release();
    occupancy.claim('mutant-b');
    first.release();
    assert.equal(occupancy.holder(), 'mutant-b', 'a stale lease must not release someone else');
  });
});

describe('occupancy: residue ledger', () => {
  test('a recorded path put back to the WRONG bytes is residue', () => {
    const root = scratch('residue');
    try {
      writeFileSync(path.join(root, 'a.mjs'), 'original\n');
      const occupancy = createOccupancy(root);
      occupancy.record(captureSnapshot(root, ['a.mjs']));
      assert.deepEqual(occupancy.residue(), [], 'an untouched tree holds no residue');

      // The exact field shape: a restore that wrote back bytes which already
      // carried another mutant's edit. Every byte-level check the runner already
      // performs passes on this tree -- only the ledger sees it.
      writeFileSync(path.join(root, 'a.mjs'), 'original with MUTATION\n');
      const found = occupancy.residue();
      assert.equal(found.length, 1);
      assert.equal(found[0].path, 'a.mjs');
      assert.match(found[0].reason, /bytes differ/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a path recorded as ABSENT that now exists is residue -- absence is a state here too', () => {
    const root = scratch('absent');
    try {
      const occupancy = createOccupancy(root);
      occupancy.record(captureSnapshot(root, ['created.mjs']));
      assert.deepEqual(occupancy.residue(), []);

      writeFileSync(path.join(root, 'created.mjs'), 'left behind\n');
      const found = occupancy.residue();
      assert.equal(found.length, 1);
      assert.equal(found[0].path, 'created.mjs');
      assert.match(found[0].reason, /should be absent/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a recorded path that has been deleted is residue', () => {
    const root = scratch('deleted');
    try {
      writeFileSync(path.join(root, 'a.mjs'), 'original\n');
      const occupancy = createOccupancy(root);
      occupancy.record(captureSnapshot(root, ['a.mjs']));
      rmSync(path.join(root, 'a.mjs'));
      const found = occupancy.residue();
      assert.equal(found.length, 1);
      assert.match(found[0].reason, /should exist/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the FIRST-SEEN bytes are kept, so a re-snapshot cannot launder residue in', () => {
    const root = scratch('first-seen');
    try {
      writeFileSync(path.join(root, 'a.mjs'), 'original\n');
      const occupancy = createOccupancy(root);
      occupancy.record(captureSnapshot(root, ['a.mjs']));

      // A second mutant snapshotting the same path while it carries residue must
      // NOT overwrite the ledger with the contaminated bytes -- that substitution
      // is what made the field bug invisible.
      writeFileSync(path.join(root, 'a.mjs'), 'contaminated\n');
      occupancy.record(captureSnapshot(root, ['a.mjs']));

      const found = occupancy.residue();
      assert.equal(found.length, 1, 'the ledger must still hold the original bytes');
      assert.equal(found[0].path, 'a.mjs');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runMutant refuses an occupied workspace before measuring anything', () => {
  test('a held lease yields ERROR / workspace-occupied and no measurement at all', async () => {
    const root = scratch('occupied');
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'a.mjs'), "export const V = 'ORIGINAL';\n");
      const resolvedSites = resolveSites(root, [
        { file: 'src/a.mjs', anchor: "'ORIGINAL'", replacement: "'MUTATED'" },
      ]);

      const occupancy = createOccupancy(root);
      occupancy.claim('the-mutant-already-in-here');

      let baselineCalls = 0;
      const narrowBaselines = {
        async get() { baselineCalls += 1; throw new Error('must not be reached'); },
      };

      const result = await runMutant({
        mutant: { id: 'second-mutant', invariant: 'x', expectFail: [], expectPass: [] },
        resolvedSites,
        narrowing: {
          mode: 'file', command: 'node --test src/a.mjs', scopes: ['src/a.mjs'], requestedNames: false, downgradeReason: null, placeholder: true,
        },
        config: {},
        adapter: { grade: 'counted', name: 'node-test' },
        workspace: { root, occupancy },
        narrowBaselines,
      });

      assert.equal(result.verdict, 'ERROR', 'an occupied workspace supports no verdict');
      assert.equal(result.reason, 'workspace-occupied');
      assert.match(result.detail, /the-mutant-already-in-here/);
      assert.equal(
        baselineCalls,
        0,
        'the guard must come before any measurement -- nothing may be run in a shared tree',
      );
      // The mutation itself is still reported, so the record is diagnosable.
      assert.equal(result.mutation[0].file, 'src/a.mjs');
      assert.equal(
        occupancy.holder(),
        'the-mutant-already-in-here',
        'the refused mutant must not have taken or released the lease',
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
