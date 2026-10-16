#!/usr/bin/env node
// The route driver: the ONE measured command a routed harness runs. Invoked as
//
//   node route-exec.mjs <name1> <cmd1> [<name2> <cmd2> ...]
//
// (compiled by lib/routing.mjs). Runs each route's command in turn -- all of
// them, even after one fails, so every route's failures are named -- and prints
// exactly one line: `@@code-mutant-routes@@ <json>`, carrying each group's
// exit, streams and report files. A JSON envelope means no framing of the
// routes' own output can collide with it. Exits 0 only when every group did.
//
// Time and teardown belong to the runner: each group runs with no deadline of
// its own and NOT detached, so it stays in this driver's process group and the
// runner's group kill (timeout or signal) reaches it.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MAX_CAPTURE_BYTES, runCommand } from './exec.mjs';
import { REPORT_DIR_ENV, createReportDir, readReports } from './reports.mjs';

export const ENVELOPE_MARKER = '@@code-mutant-routes@@';

export async function runRoutes(pairs, { cwd = process.cwd(), env = process.env } = {}) {
  // Run by hand there is no runner-provided dir, so the driver makes its own.
  const owned = env[REPORT_DIR_ENV] ? null : createReportDir();
  const reportRoot = owned ? owned.dir : env[REPORT_DIR_ENV];
  const groups = [];
  // One budget across every group's streams and reports: the envelope carries
  // them all, and the runner's capture cap is the ceiling for the whole of it.
  let spent = 0;
  try {
    for (const [route, command] of pairs) {
      const dir = path.join(reportRoot, route);
      mkdirSync(dir, { recursive: true });
      const run = await runCommand(command, {
        cwd, timeoutMs: 0, detached: false, env: { ...env, [REPORT_DIR_ENV]: dir },
      });
      spent += run.capturedBytes ?? 0;
      const read = readReports(dir, MAX_CAPTURE_BYTES - spent);
      spent += read.bytes;
      groups.push({
        route,
        exitCode: run.exitCode,
        signal: run.signal,
        durationMs: run.durationMs,
        truncated: run.truncated || read.truncated || spent > MAX_CAPTURE_BYTES,
        outputIncomplete: run.outputIncomplete,
        spawnError: run.spawnError,
        stdout: run.stdout,
        stderr: run.stderr,
        reports: read.reports,
      });
    }
  } finally {
    owned?.release();
  }
  return groups;
}

function pairsFrom(argv) {
  if (!argv.length || argv.length % 2 !== 0) {
    throw new Error('usage: route-exec.mjs <name> <command> [<name> <command> ...]');
  }
  const pairs = [];
  for (let i = 0; i < argv.length; i += 2) pairs.push([argv[i], argv[i + 1]]);
  return pairs;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const groups = await runRoutes(pairsFrom(process.argv.slice(2)));
  process.stdout.write(`${ENVELOPE_MARKER} ${JSON.stringify({ groups })}\n`);
  // exitCode, never process.exit(): the envelope may be larger than the pipe
  // buffer, and an explicit exit could cut it short.
  process.exitCode = groups.every((group) => group.exitCode === 0) ? 0 : 1;
}
