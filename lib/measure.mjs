// Runs one measured command with the project's setup/teardown hooks around it,
// then parses the output through the adapter.
//
// The hooks are the config-only escape hatch for the things a fixed schema would
// otherwise calcify against: reset the DB, run the build, start a service. They
// wrap every measured command -- baseline, narrow baseline, canary and each mutant
// -- because a hook that only ran for mutants would leave the baseline measured
// under different conditions than the thing it is the reference for.

import { runCommand } from './exec.mjs';

// Pure, so every branch is testable with no subprocess.
//
// `Math.min` against `timeoutMs` is what keeps the ceiling a ceiling: the derived
// deadline may only ever be TIGHTER than the configured one, never looser, so
// adding this can never make a run take longer than it does today. `Math.max`
// against `floorMs` is the other direction -- it stops a fast reference from
// producing a deadline so tight that ordinary variance reads as a hang.
export function hangDeadlineMs({ referenceMs, factor, floorMs, timeoutMs }) {
  if (factor <= 0) return timeoutMs;
  return Math.min(timeoutMs, Math.max(floorMs, Math.ceil(factor * referenceMs)));
}

// THE ONE RULE, in one place: a measured command with a like-for-like unmutated
// reference gets its deadline from that reference. A command with no reference --
// the global baseline, a narrow baseline, a setup/teardown hook -- falls back to
// the configured ceiling, because there is nothing to derive from.
export function deadlineFor(config, referenceMs) {
  if (typeof referenceMs !== 'number' || !Number.isFinite(referenceMs)) return config.timeoutMs;
  return hangDeadlineMs({
    referenceMs,
    factor: config.hang.factor,
    floorMs: config.hang.floorMs,
    timeoutMs: config.timeoutMs,
  });
}

// `deadlineMs` applies to the MEASURED COMMAND ONLY. The hooks keep the
// configured ceiling: they are not the thing being compared against a reference,
// and a hook killed early would be a setup that silently did not finish.
export async function measure({ command, config, adapter, workspace, deadlineMs = null }) {
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

  const run = await runCommand(command, {
    ...options,
    timeoutMs: deadlineMs ?? config.timeoutMs,
  });

  let teardownRun = null;
  if (config.teardown) {
    teardownRun = await runCommand(config.teardown, options);
  }

  const parsed = adapter.parse(run.stdout, run.stderr, run.exitCode);

  return {
    command,
    run,
    parsed,
    deadlineMs: deadlineMs ?? config.timeoutMs,
    setupRun,
    teardownRun,
    hookFailure: teardownRun && (teardownRun.exitCode !== 0 || teardownRun.timedOut)
      ? { phase: 'teardown', run: teardownRun }
      : null,
  };
}

// A measured command counts as green when nothing failed, something actually
// ran, AND the exit code agrees with the counters. None of the three is
// decoration:
//   - a command that silently runs zero tests is the failure mode that makes
//     every mutant read SURVIVED, i.e. turns every finding into a false one;
//   - a counted runner can exit non-zero while reporting no failures at all (a
//     guardrail step chained onto the command, a crash after the summary
//     banner), and trusting the counters alone there measures a baseline the
//     adapter cannot actually see the state of.
export function isGreen({ run, parsed }) {
  if (run.timedOut || run.spawnError || run.truncated || run.outputIncomplete) return false;
  if (!parsed || parsed.grade === 'exit-code') return run.exitCode === 0;
  if (parsed.compileError) return false;
  if (parsed.failed > 0) return false;
  if (run.exitCode !== 0) return false;
  return parsed.ran > 0;
}

export function describeNotGreen({ run, parsed }) {
  if (run.spawnError) return `the command could not be started: ${run.spawnError}`;
  if (run.timedOut) return `the command timed out after ${Math.round(run.durationMs)}ms`;
  if (run.truncated) {
    return 'the command\'s captured output exceeded the capture limit and was truncated -- nothing it reports can be trusted';
  }
  if (run.outputIncomplete) {
    return 'the command exited but its output streams were still open when the drain grace expired, so '
      + 'something else was holding them -- the capture may be short and nothing it reports can be trusted';
  }
  if (!parsed || parsed.grade === 'exit-code') return `the command exited ${run.exitCode}`;
  if (parsed.compileError) return `the command reported a build/compile break (exit ${run.exitCode})`;
  if (parsed.failed > 0) {
    const ids = parsed.failedTests.map((t) => t.id).join(', ') || '(none named)';
    return `${parsed.failed} test(s) already failing before any mutation: ${ids}`;
  }
  if (parsed.ran === 0) {
    return `the command ran ZERO tests (exit ${run.exitCode}), so nothing it reports can be trusted`;
  }
  if (run.exitCode !== 0) {
    return `the command exited ${run.exitCode} while reporting zero test failures -- something the `
      + 'adapter cannot see went wrong, so nothing it reports can be trusted';
  }
  return `the command exited ${run.exitCode}`;
}
