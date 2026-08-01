// Wires restore to process teardown, so an interrupted run cannot leave a
// mutation behind. Order matters: kill the child process group FIRST (nothing
// may still be reading a mutated file), then run the cleanups.

import { cleanupCount, runCleanupsSync } from './cleanup.mjs';
import { killAllChildrenSync } from './exec.mjs';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

let installed = false;

function emergencyCleanup(reason) {
  if (cleanupCount() === 0) {
    killAllChildrenSync();
    return;
  }
  killAllChildrenSync();
  process.stderr.write(`\ncode-mutant: ${reason} -- restoring the tree before exit\n`);
  const failures = runCleanupsSync();
  if (failures.length) {
    process.stderr.write('code-mutant: RESTORE INCOMPLETE. Inspect these paths by hand:\n');
    for (const f of failures) {
      process.stderr.write(`  ${f.path ?? f.label ?? '?'}: ${f.error ?? f.reason}\n`);
    }
  } else {
    process.stderr.write('code-mutant: tree restored\n');
  }
}

export function installGuard() {
  if (installed) return;
  installed = true;

  process.on('exit', () => emergencyCleanup('exiting'));

  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      emergencyCleanup(`received ${signal}`);
      process.exit(SIGNAL_EXIT_CODES[signal]);
    });
  }

  process.on('uncaughtException', (err) => {
    emergencyCleanup('uncaught exception');
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(3);
  });

  process.on('unhandledRejection', (err) => {
    emergencyCleanup('unhandled rejection');
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(3);
  });
}
