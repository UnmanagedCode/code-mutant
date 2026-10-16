// The report-file channel (lib/reports.mjs) as measure() drives it: a fresh dir
// per measured command, outside the workspace, handed to the parser as
// `context.reports`, counted against the capture cap, and always removed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanupCount, runCleanupsSync } from '../lib/cleanup.mjs';
import { Reason, Verdict, classify } from '../lib/classify.mjs';
import { MAX_CAPTURE_BYTES } from '../lib/exec.mjs';
import { measure } from '../lib/measure.mjs';
import { createReportDir } from '../lib/reports.mjs';

const CONFIG = { timeoutMs: 10_000, hang: { factor: 10, floorMs: 0 }, setup: null, teardown: null };

// Records what parse() was handed, and nothing else.
const RECORDING = {
  grade: 'counted',
  parse: (stdout, stderr, exitCode, context) => ({
    grade: 'counted', passed: 1, failed: 0, skipped: 0, ran: 1, failedTests: [], compileError: false,
    counts: {}, stdout, context,
  }),
};

function withWorkspace(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-reports-ws-'));
  return Promise.resolve(body({ root })).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('report dir per measured command', () => {
  // Invariants: the dir is fresh per command, outside the workspace, its regular
  // files reach parse() keyed by basename, and it is gone afterwards.
  test('the files a command writes reach parse() as context.reports, then the dir is removed', async () => {
    await withWorkspace(async (workspace) => {
      const command = 'printf "%s" "$CODE_MUTANT_REPORT_DIR"; printf one > "$CODE_MUTANT_REPORT_DIR/a.json"; '
        + 'mkdir "$CODE_MUTANT_REPORT_DIR/sub"; printf nested > "$CODE_MUTANT_REPORT_DIR/sub/b.json"';
      const first = await measure({ command, config: CONFIG, adapter: RECORDING, workspace });
      const second = await measure({ command, config: CONFIG, adapter: RECORDING, workspace });

      const dir = first.parsed.stdout;
      assert.ok(path.isAbsolute(dir) && dir.startsWith(os.tmpdir()), dir);
      assert.ok(!dir.startsWith(workspace.root), 'outside the workspace');
      assert.notEqual(second.parsed.stdout, dir, 'a fresh dir per command');
      assert.deepEqual(first.parsed.context, { cwd: workspace.root, reports: { 'a.json': 'one' } });
      assert.equal(existsSync(dir), false, 'removed after parse');
      assert.equal(existsSync(second.parsed.stdout), false);
      assert.equal(cleanupCount(), 0, 'nothing left registered with the exit/signal guard');
    });
  });

  test('a command that writes nothing hands parse() an empty map', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = await measure({ command: 'true', config: CONFIG, adapter: RECORDING, workspace });
      assert.deepEqual(outcome.parsed.context.reports, {});
    });
  });

  test('a timed-out command still has its dir removed', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = await measure({
        command: 'printf "%s" "$CODE_MUTANT_REPORT_DIR"; exec sleep 5', config: CONFIG, adapter: RECORDING, workspace, deadlineMs: 300,
      });
      assert.equal(outcome.run.timedOut, true);
      assert.ok(outcome.parsed.stdout);
      assert.equal(existsSync(outcome.parsed.stdout), false);
    });
  });

  // Invariant: report bytes count toward the capture cap -- over it is a
  // truncated capture, so ERROR output-truncated, never a verdict.
  test('a report past the capture cap marks the run truncated and withholds the reports', async () => {
    await withWorkspace(async (workspace) => {
      const outcome = await measure({
        command: `head -c ${MAX_CAPTURE_BYTES + 1} /dev/zero > "$CODE_MUTANT_REPORT_DIR/big.json"`,
        config: CONFIG,
        adapter: RECORDING,
        workspace,
      });
      assert.equal(outcome.run.truncated, true);
      assert.deepEqual(outcome.parsed.context.reports, {});
      const verdict = classify({ run: outcome.run, parsed: outcome.parsed, expectFail: ['t::a'] });
      assert.equal(verdict.verdict, Verdict.ERROR);
      assert.equal(verdict.reason, Reason.OUTPUT_TRUNCATED);
    });
  });

  // Invariant: an interrupted measurement removes its dir -- the guard's
  // cleanup pass reaches it.
  test('the exit/signal cleanup pass removes a dir still in use', () => {
    const reportDir = createReportDir();
    assert.ok(existsSync(reportDir.dir));
    assert.equal(runCleanupsSync().length, 0);
    assert.equal(existsSync(reportDir.dir), false);
    reportDir.release(); // idempotent after the guard ran
  });
});
