// Byte-snapshot restore, with absence treated as a state.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ABSENT, SnapshotError, assertSafeRelPath, captureSnapshot, restoreAndVerify, restoreSnapshot,
  verifySnapshot,
} from '../lib/snapshot.mjs';
import { cleanupCount, registerCleanup, runCleanupsSync } from '../lib/cleanup.mjs';

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), 'code-mutant-snap-'));
}

describe('path safety', () => {
  test('rejects the paths that would make restore destructive', () => {
    for (const bad of ['', '.', '..', '../outside', 'a/../../b', '/etc/passwd']) {
      assert.throws(() => assertSafeRelPath(bad), SnapshotError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('accepts ordinary relative paths', () => {
    assert.equal(assertSafeRelPath('src/a.mjs'), path.normalize('src/a.mjs'));
    assert.equal(assertSafeRelPath('./src/a.mjs'), path.normalize('src/a.mjs'));
  });
});

describe('snapshot and restore', () => {
  test('a modified file comes back byte-identical', () => {
    const root = scratch();
    try {
      writeFileSync(path.join(root, 'a.txt'), 'original\n');
      const snap = captureSnapshot(root, ['a.txt']);
      writeFileSync(path.join(root, 'a.txt'), 'MUTATED');
      assert.deepEqual(restoreSnapshot(snap), []);
      assert.equal(readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ABSENCE IS A STATE: a created file is deleted on restore', () => {
    const root = scratch();
    try {
      const snap = captureSnapshot(root, ['created.txt']);
      assert.equal(snap.entries.get('created.txt').content, ABSENT);
      writeFileSync(path.join(root, 'created.txt'), 'appeared');
      restoreSnapshot(snap);
      assert.equal(existsSync(path.join(root, 'created.txt')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a deleted file is recreated byte-identical', () => {
    const root = scratch();
    try {
      const bytes = Buffer.from([0, 1, 2, 250, 255, 10]);
      writeFileSync(path.join(root, 'bin.dat'), bytes);
      const snap = captureSnapshot(root, ['bin.dat']);
      rmSync(path.join(root, 'bin.dat'));
      restoreSnapshot(snap);
      assert.ok(readFileSync(path.join(root, 'bin.dat')).equals(bytes));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the executable bit survives restore', () => {
    const root = scratch();
    try {
      const file = path.join(root, 'run.sh');
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o755);
      const snap = captureSnapshot(root, ['run.sh']);
      writeFileSync(file, 'mutated');
      chmodSync(file, 0o644);
      restoreSnapshot(snap);
      assert.equal(lstatSync(file).mode & 0o777, 0o755);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a directory the apply created is removed, one holding other files is not', () => {
    const root = scratch();
    try {
      const snap = captureSnapshot(root, ['made/up/deep.txt', 'kept/also.txt']);
      mkdirSync(path.join(root, 'made/up'), { recursive: true });
      writeFileSync(path.join(root, 'made/up/deep.txt'), 'x');
      mkdirSync(path.join(root, 'kept'), { recursive: true });
      writeFileSync(path.join(root, 'kept/also.txt'), 'x');
      writeFileSync(path.join(root, 'kept/unrelated.txt'), 'not ours');

      restoreSnapshot(snap);

      assert.equal(existsSync(path.join(root, 'made')), false, 'created dirs should be removed');
      assert.equal(existsSync(path.join(root, 'kept/also.txt')), false, 'created file should be removed');
      assert.equal(existsSync(path.join(root, 'kept/unrelated.txt')), true, 'unrelated file must survive');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a directory where a mutated file should be is refused rather than guessed at', () => {
    const root = scratch();
    try {
      mkdirSync(path.join(root, 'd'));
      assert.throws(() => captureSnapshot(root, ['d']), SnapshotError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('verification', () => {
  test('drift is detected in both directions', () => {
    const root = scratch();
    try {
      writeFileSync(path.join(root, 'a.txt'), 'original\n');
      const snap = captureSnapshot(root, ['a.txt', 'absent.txt']);

      assert.deepEqual(verifySnapshot(snap), []);

      writeFileSync(path.join(root, 'a.txt'), 'drifted');
      writeFileSync(path.join(root, 'absent.txt'), 'should not be here');
      const drift = verifySnapshot(snap);
      assert.equal(drift.length, 2);
      assert.match(drift.find((d) => d.path === 'a.txt').reason, /bytes differ/);
      assert.match(drift.find((d) => d.path === 'absent.txt').reason, /should be absent/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('restoreAndVerify throws loudly when it cannot put the tree back', () => {
    const root = scratch();
    try {
      writeFileSync(path.join(root, 'a.txt'), 'original\n');
      const snap = captureSnapshot(root, ['a.txt']);
      // Make restore impossible: the parent becomes a file where a dir must be.
      snap.entries.set('sub/dir/x.txt', { content: Buffer.from('x'), mode: 0o644 });
      writeFileSync(path.join(root, 'sub'), 'blocking file');
      assert.throws(() => restoreAndVerify(snap), /restore did not return the tree/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('cleanup registry', () => {
  test('registered cleanups run in reverse order and are collected, not thrown', () => {
    const order = [];
    const before = cleanupCount();
    assert.equal(before, 0, 'tests should start with no leaked cleanups');

    registerCleanup(() => { order.push('first'); }, 'first');
    registerCleanup(() => { order.push('second'); throw new Error('boom'); }, 'second');

    const failures = runCleanupsSync();
    assert.deepEqual(order, ['second', 'first']);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].label, 'second');
    assert.equal(cleanupCount(), 0);
  });
});
