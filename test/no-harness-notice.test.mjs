// A project with no harness: the CLI contract.
//
// Observable only through the real CLI, because the thing under test IS the
// stdout/stderr split and the exit code -- the three signals a conductor and a
// reviewer actually read. Asserting on the thrown error instead would prove
// nothing about which stream the notice lands on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ExitCode } from '../lib/report.mjs';
import { runCli } from './helpers/cli.mjs';
import { guardFiles, makeRepo } from './helpers/tmp-repo.mjs';

// Every subcommand except `candidates` reaches loadConfig through the shared
// buildContext, so the notice has to be uniform across all of them.
const COMMANDS = [
  ['baseline', ['baseline']],
  ['run --all', ['run', '--all']],
  ['validate', ['validate']],
  ['probe', ['probe', '--file', 'src/guard.mjs', '--anchor', "'ollama'", '--replace', "'x'"]],
];

describe('a project with no harness', () => {
  for (const [label, args] of COMMANDS) {
    test(`${label} reports the absence without erroring`, async () => {
      const repo = makeRepo({ files: guardFiles(), config: null, label: 'no-harness-cli' });
      try {
        const result = await runCli(args, { cwd: repo.root });

        // Pins "not an error" mechanically: the notice is informational, so
        // nothing may reach stderr. This is what regresses if someone later
        // routes the notice back through the generic catch, which prefixes
        // `code-mutant: ` and writes to stderr.
        assert.equal(result.stderr, '', 'a supported state must not write to stderr');
        assert.doesNotMatch(result.stdout, /^code-mutant: /m, 'no error prefix');

        assert.match(result.stdout, /not configured for mutation testing/);
        assert.match(result.stdout, /scaffold\/harness\.md/);

        assert.equal(result.exitCode, ExitCode.NO_HARNESS);
        // Pins the invariant this card exists to protect: exit 0 means "gates
        // passed, no survivors", so a run that measured NOTHING must never land
        // there. Stated separately from the equality above so a future "it's not
        // an error, just exit 0" simplification fails on its own line.
        assert.notEqual(result.exitCode, ExitCode.CLEAN, 'nothing ran -- it cannot read as a clean sweep');
      } finally { repo.cleanup(); }
    });
  }

  // The plain-text notice is deliberate under --json: there is no report object
  // to shape, no consumer parses it, and the reader is an LLM. Pinned so the
  // omission cannot be mistaken for a bug and "fixed" into a JSON envelope.
  test('--json gets the same plain-text notice, not a report envelope', async () => {
    const repo = makeRepo({ files: guardFiles(), config: null, label: 'no-harness-json' });
    try {
      const result = await runCli(['baseline', '--json'], { cwd: repo.root });
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /not configured for mutation testing/);
      assert.equal(result.exitCode, ExitCode.NO_HARNESS);
    } finally { repo.cleanup(); }
  });
});
