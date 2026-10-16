// The report-file channel: a fresh, empty directory per measured command, for a
// runner that writes a machine report to a file rather than to stdout.
//
// Why a file and not stdout: lib/exec.mjs captures a command's output through
// Node's `stdio: 'pipe'`, which on Linux hands the child a Unix SOCKET, and a
// socket cannot be `open()`ed by path -- so a runner told to write its report to
// `/dev/stdout` fails with ENXIO. The directory sits under os.tmpdir(), outside
// every workspace, so copy and in-place isolation behave the same and nothing
// lands in the tree.
//
// The command finds it through the environment, e.g.
//   --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"
// and the parser receives what was written as `context.reports`, a map from each
// regular file's basename to its text.

import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerCleanup, unregisterCleanup } from './cleanup.mjs';

export const REPORT_DIR_ENV = 'CODE_MUTANT_REPORT_DIR';

// Registered with the exit/signal guard, so an interrupted measurement removes
// its directory too. `release()` removes it and drops the registration;
// idempotent, as the cleanup registry requires.
export function createReportDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-report-'));
  const remove = () => { rmSync(dir, { recursive: true, force: true }); };
  const cleanupId = registerCleanup(remove, `remove report dir ${dir}`);
  return {
    dir,
    release() {
      unregisterCleanup(cleanupId);
      remove();
    },
  };
}

// Every regular file directly in `dir`, read only while the running total stays
// within `budgetBytes` -- the share of the capture cap the command's stdout and
// stderr left over. Over budget, `truncated` is set and the reports are
// withheld: the caller treats that exactly as a truncated capture, so a report
// too large to trust can cost a verdict but never shape one.
export function readReports(dir, budgetBytes) {
  const reports = {};
  let bytes = 0;
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return { reports, bytes, truncated: false };
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    const stat = lstatSync(abs);
    if (!stat.isFile()) continue;
    bytes += stat.size;
    if (bytes > budgetBytes) return { reports: {}, bytes, truncated: true };
    reports[name] = readFileSync(abs, 'utf8');
  }
  return { reports, bytes, truncated: false };
}
