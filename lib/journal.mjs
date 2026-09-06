// The per-mutant verdict journal: what makes an interrupted run resumable.
//
// `run` wrote `.mutation/results/<runId>.json` exactly once, AFTER execute()
// returned. An interrupted run therefore lost 100% of its work no matter how many
// mutants had already been graded -- and card 2026-0036's field evidence is five
// conductor wake windows spent re-paying exactly that. Measured (Part 1, S3):
// twelve learn mutants cost 25s of measured commands on top of 4s of gates, so an
// interrupt after ten of them threw away ~80% of the run.
//
// ONE RESPONSIBILITY: derive the key, append a line, read the lines back. It
// decides nothing about what may be reused -- lib/runner.mjs owns that.
//
// JSON Lines, appended and flushed per mutant, because the whole point is to
// survive a process that does not get to run its exit path. A single JSON document
// rewritten per mutant would be a torn file after a SIGKILL mid-write.

import {
  appendFileSync, existsSync, mkdirSync, readFileSync,
} from 'node:fs';
import path from 'node:path';

import { MUTATION_DIR, assertMutationDirIgnored, mutationDir } from './catalog.mjs';
import { canonical, configFingerprint, sha256 } from './fingerprint.mjs';

export const JOURNAL_DIR = 'journal';

export function journalDir(repoRoot) {
  return path.join(mutationDir(repoRoot), JOURNAL_DIR);
}

// WHAT MAKES A JOURNAL APPLICABLE TO THIS INVOCATION.
//
// `mutatedSha` first: a verdict earned against different code says nothing about
// this code. `jobs` is in here deliberately -- reusing a jobs=4 verdict inside a
// jobs=1 re-run would hide precisely the concurrent-suite hazard the README tells
// a reader to check for. `hang` is inside `configFingerprint`, so retuning
// `hang.factor` automatically forces every hung mutant to be re-run rather than
// resurrecting a verdict the old deadline produced.
export function journalKey({ mutatedSha, config, adapter, isolation, jobs, learn }) {
  return sha256(canonical({
    mutatedSha,
    configFingerprint: configFingerprint(config),
    adapter: { name: adapter.name, grade: adapter.grade, modulePath: adapter.modulePath ?? null },
    isolation,
    jobs,
    learn: Boolean(learn),
  })).slice(0, 32);
}

// EVERYTHING THAT CHANGES WHAT IS MEASURED, and deliberately nothing else.
//
// `invariant`, `whyNotEquivalent` and `waived` are excluded: they are prose and
// decisions, re-read from the current catalog on resume. So marking a survivor
// `waived` (skills/prove/SKILL.md step 9) costs no re-run -- which is the whole
// reason waivers are cheap to record.
export function mutantFingerprint(mutant) {
  return sha256(canonical({
    id: mutant.id,
    sites: mutant.sites ?? null,
    expectFail: mutant.expectFail ?? [],
    expectPass: mutant.expectPass ?? [],
    narrowTo: mutant.narrowTo ?? null,
    narrowCommand: mutant.narrowCommand ?? null,
  })).slice(0, 32);
}

export function journalPath(repoRoot, key) {
  return path.join(journalDir(repoRoot), `${key}.jsonl`);
}

// Guarded by the same gitignore assertion as `.mutation/results/`: a journal is
// no more committable than a results file.
export function openJournal({ repoRoot, key, header }) {
  assertMutationDirIgnored(repoRoot);
  const file = journalPath(repoRoot, key);
  let started = existsSync(file);
  return {
    file,
    // Appended per mutant and flushed, so a SIGKILL loses at most the mutant that
    // was in flight.
    appendResult(fingerprint, result) {
      if (!started) {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ kind: 'header', key, ...header })}\n`);
        started = true;
      }
      appendFileSync(file, `${JSON.stringify({ kind: 'result', fingerprint, result })}\n`);
    },
  };
}

// Tolerant of a torn final line: a SIGKILL mid-append can leave one. Every
// COMPLETE line before it is still a verdict whose tree was restored and proved
// (lib/runner.mjs only journals after restoreAndVerify returned), so discarding
// the whole file over a partial tail would throw away exactly the work this
// module exists to keep.
export function readJournal(repoRoot, key) {
  const file = journalPath(repoRoot, key);
  if (!existsSync(file)) return null;
  let header = null;
  const results = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.kind === 'header') header = entry;
    else if (entry.kind === 'result' && entry.fingerprint) results.set(entry.fingerprint, entry.result);
  }
  return { file, key, header, results };
}

export const JOURNAL_DIR_REL = path.posix.join(MUTATION_DIR, JOURNAL_DIR);
