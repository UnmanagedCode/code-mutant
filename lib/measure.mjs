// Runs one measured command with the project's setup/teardown hooks around it,
// then parses the output through the adapter.
//
// The hooks are the config-only escape hatch for the things a fixed schema would
// otherwise calcify against: reset the DB, run the build, start a service. They
// wrap every measured command -- baseline, narrow baseline, canary and each mutant
// -- because a hook that only ran for mutants would leave the baseline measured
// under different conditions than the thing it is the reference for.

import { runCommand } from './exec.mjs';

export async function measure({ command, config, adapter, workspace }) {
  const options = { cwd: workspace.root, timeoutMs: config.timeoutMs };

  let setupRun = null;
  if (config.setup) {
    setupRun = await runCommand(config.setup, options);
    if (setupRun.exitCode !== 0 || setupRun.timedOut) {
      return {
        command,
        run: setupRun,
        parsed: null,
        setupRun,
        teardownRun: null,
        hookFailure: { phase: 'setup', run: setupRun },
      };
    }
  }

  const run = await runCommand(command, options);

  let teardownRun = null;
  if (config.teardown) {
    teardownRun = await runCommand(config.teardown, options);
  }

  const parsed = adapter.parse(run.stdout, run.stderr, run.exitCode);

  return {
    command,
    run,
    parsed,
    setupRun,
    teardownRun,
    hookFailure: teardownRun && (teardownRun.exitCode !== 0 || teardownRun.timedOut)
      ? { phase: 'teardown', run: teardownRun }
      : null,
  };
}

// A measured command counts as green when nothing failed AND something actually
// ran. The "something actually ran" half is not decoration: a command that
// silently runs zero tests is the failure mode that makes every mutant read
// SURVIVED, i.e. turns every finding into a false one.
export function isGreen({ run, parsed }) {
  if (run.timedOut || run.spawnError) return false;
  if (!parsed || parsed.grade === 'exit-code') return run.exitCode === 0;
  if (parsed.compileError) return false;
  if (parsed.failed > 0) return false;
  return parsed.ran > 0;
}

export function describeNotGreen({ run, parsed }) {
  if (run.spawnError) return `the command could not be started: ${run.spawnError}`;
  if (run.timedOut) return `the command timed out after ${Math.round(run.durationMs)}ms`;
  if (!parsed || parsed.grade === 'exit-code') return `the command exited ${run.exitCode}`;
  if (parsed.compileError) return `the command reported a build/compile break (exit ${run.exitCode})`;
  if (parsed.failed > 0) return `${parsed.failed} test(s) already failing before any mutation`;
  if (parsed.ran === 0) {
    return `the command ran ZERO tests (exit ${run.exitCode}), so nothing it reports can be trusted`;
  }
  return `the command exited ${run.exitCode}`;
}
