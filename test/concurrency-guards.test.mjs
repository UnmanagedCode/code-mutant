// A VERDICT THAT COULD HAVE BEEN AFFECTED BY CONCURRENCY IS NEVER A PLAIN VERDICT.
//
// The ordinal fix (test/parallel-isolation.test.mjs) stops two mutants sharing a
// copy. These tests are about what happens if something ever gets past it, because
// the argument it replaced -- "each worker owns its own copy, so nothing is
// shared" -- was written in this codebase and was already wrong once.
//
// Both run at jobs=1, with the interleave produced in-process by the measured
// command itself rather than by racing two real runs, so both are exactly
// deterministic. Both fakes report GREEN, because green is what turns an
// unguarded run into a false finding.
//
// Note the direction the guards must go. The race that produced card 2026-0029's
// false SURVIVED produces a false KILLED just as easily and in total silence, so a
// tainted run cannot be downgraded to a weaker verdict -- ERROR (no verdict) is
// the only honest output.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAdapter } from '../lib/adapters/index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { ExitCode, exitCodeFor } from '../lib/report.mjs';
import { execute } from '../lib/runner.mjs';
import { makeRepo } from './helpers/tmp-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAMPER = path.join(HERE, 'helpers', 'tampering-command.mjs');

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

function filesFor(letters) {
  const files = {};
  for (const letter of letters) {
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

async function runTampered({ letters, env, label }) {
  const repo = makeRepo({
    files: filesFor(letters),
    config: {
      // Real baseline, so the baseline and canary gates are genuine.
      baselineCommand: 'node --test',
      testCommand: `node ${JSON.stringify(TAMPER)} {tests}`,
      runner: 'node-test',
      isolation: 'copy',
      jobs: 1,
    },
    label,
  });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'code-mutant-tamper-'));
  try {
    const resolved = { ...env };
    if (resolved.CM_TAMPER_CONTENT_TEXT) {
      const file = path.join(scratch, 'pristine');
      writeFileSync(file, resolved.CM_TAMPER_CONTENT_TEXT);
      resolved.CM_TAMPER_CONTENT = file;
      delete resolved.CM_TAMPER_CONTENT_TEXT;
    }
    for (const [key, value] of Object.entries(resolved)) process.env[key] = value;

    const config = loadConfig({ repoRoot: repo.root, overrides: { isolation: 'copy' } });
    const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
    const report = await execute({ config, adapter, mutants: letters.map(mutantFor) });
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    return { report, byId, repo };
  } finally {
    for (const key of ['CM_TAMPER_MODE', 'CM_TAMPER_SCOPE', 'CM_TAMPER_PATH', 'CM_TAMPER_CONTENT', 'CM_TAMPER_GUARD']) {
      delete process.env[key];
    }
    rmSync(scratch, { recursive: true, force: true });
    repo.cleanup();
  }
}

describe('a mutation that did not survive its own measured run yields no verdict', () => {
  test('the mutation reverted mid-run reads ERROR / mutation-not-intact, NOT SURVIVED', async () => {
    // The exact shape of card 2026-0029's false SURVIVED: something put the file
    // back while the command was running, so the suite went green with nothing
    // applied and the counts matched the narrow baseline perfectly.
    const { report, byId } = await runTampered({
      letters: ['a'],
      label: 'not-intact',
      env: {
        CM_TAMPER_MODE: 'revert',
        CM_TAMPER_SCOPE: 'test/a.test.mjs',
        CM_TAMPER_PATH: 'src/a.mjs',
        CM_TAMPER_GUARD: 'src/a.mjs',
        CM_TAMPER_CONTENT_TEXT: moduleSource('a'),
      },
    });

    const result = byId['mutate-a'];
    assert.equal(
      result.verdict,
      'ERROR',
      `a run whose mutation was not intact throughout supports no verdict, got ${result.verdict}: ${result.detail}`,
    );
    assert.equal(result.reason, 'mutation-not-intact');
    assert.match(result.detail, /src\/a\.mjs/);

    // Without the guard this is the false finding: 1 passed, 0 failed, exit 0 ->
    // SURVIVED -> exit 1, which reads as a real coverage hole AND as a gate
    // failure. The counts are still reported, so the record stays diagnosable.
    assert.equal(result.mutantCounts.failed, 0, 'the tampered run really did report green');
    assert.equal(
      exitCodeFor(report),
      ExitCode.NO_VERDICT,
      'this must exit 5 (no verdict), never 1 (a survivor a reviewer would relay)',
    );

    // The revert wrote back exactly the pre-mutation bytes, so restore itself had
    // nothing to complain about -- which is why byte verification alone never
    // caught this.
    assert.equal(report.noTrace.ok, true);
  });
});

describe('foreign mutation bytes in a workspace invalidate the verdicts measured there', () => {
  test('a command that contaminates another site file errors BOTH itself and the next mutant', async () => {
    // mutate-b's command writes foreign bytes into src/a.mjs -- a path already in
    // the ledger from mutate-a, and already restored. b's own snapshot covers only
    // src/b.mjs, so b's restore cannot undo it and the copy stays contaminated for
    // the rest of its life. This is step 4 of the field mechanism: a restore that
    // faithfully replayed bytes which already carried another mutant's edit.
    const { report, byId } = await runTampered({
      letters: LETTERS,
      label: 'residue',
      env: {
        CM_TAMPER_MODE: 'contaminate',
        CM_TAMPER_SCOPE: 'test/b.test.mjs',
        CM_TAMPER_PATH: 'src/a.mjs',
        CM_TAMPER_GUARD: 'src/b.mjs',
      },
    });

    // mutate-a ran before the contamination and is a genuine measurement.
    assert.equal(byId['mutate-a'].verdict, 'SURVIVED', byId['mutate-a'].detail);

    // The mutant that DID the contaminating does not get to report a verdict
    // either -- the entry check alone would have let it through and made only the
    // next mutant pay.
    assert.equal(byId['mutate-b'].verdict, 'ERROR', byId['mutate-b'].detail);
    assert.equal(byId['mutate-b'].reason, 'workspace-residue');

    // And the next mutant, whose own sites are perfectly intact, is refused for a
    // tree it never touched -- the IMPRECISE-on-an-unreachable-test half of the
    // field report.
    assert.equal(byId['mutate-c'].verdict, 'ERROR', byId['mutate-c'].detail);
    assert.equal(byId['mutate-c'].reason, 'workspace-residue');
    assert.match(byId['mutate-c'].detail, /src\/a\.mjs/);

    // Copy-mode no-trace used to be a constant `{ok: true}`, which is why a
    // contaminated copy reported nothing wrong.
    assert.equal(report.noTrace.ok, false, 'a copy holding mutation bytes is not a no-trace run');
    assert.equal(report.noTrace.residue.length, 1);
    assert.equal(report.noTrace.residue[0].path, 'src/a.mjs');
    assert.ok(report.noTrace.residue[0].workspace, 'the residue must name which copy held it');

    // Deliberate precedence: RESTORE_FAILED outranks both SURVIVORS and
    // NO_VERDICT. mutate-a's SURVIVED is real, but "the tree is not as it was" is
    // the more urgent instruction, and exit 1 would send a reviewer to relay a
    // finding from a run whose integrity failed.
    assert.equal(exitCodeFor(report), ExitCode.RESTORE_FAILED);
  });
});

describe('the real tree is untouched by either failure mode', () => {
  test('copy mode leaves no trace in the repo even when a guard fires', async () => {
    const repo = makeRepo({
      files: filesFor(['a']),
      config: {
        baselineCommand: 'node --test',
        testCommand: `node ${JSON.stringify(TAMPER)} {tests}`,
        runner: 'node-test',
        isolation: 'copy',
        jobs: 1,
      },
      label: 'untouched',
    });
    try {
      const statusBefore = repo.status();
      process.env.CM_TAMPER_MODE = 'contaminate';
      process.env.CM_TAMPER_SCOPE = 'test/a.test.mjs';
      process.env.CM_TAMPER_PATH = 'src/a.mjs';
      process.env.CM_TAMPER_GUARD = 'src/a.mjs';
      const config = loadConfig({ repoRoot: repo.root, overrides: { isolation: 'copy' } });
      const adapter = await loadAdapter(config.runner, { configDir: config.configDir });
      await execute({ config, adapter, mutants: [mutantFor('a')] });

      assert.equal(repo.status(), statusBefore, 'the real tree must be byte-identical');
      assert.equal(
        readFileSync(path.join(repo.root, 'src', 'a.mjs'), 'utf8'),
        moduleSource('a'),
        'contamination happened in the copy, never in the repo',
      );
      assert.equal(existsSync(path.join(repo.root, 'src', 'a.mjs')), true);
    } finally {
      for (const key of ['CM_TAMPER_MODE', 'CM_TAMPER_SCOPE', 'CM_TAMPER_PATH', 'CM_TAMPER_GUARD']) {
        delete process.env[key];
      }
      repo.cleanup();
    }
  });
});
