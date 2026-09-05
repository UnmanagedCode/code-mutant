// Every git call whose stdout is read, and the one bound on how much of it is
// held.
//
// execFileSync's default maxBuffer is 1 MiB, and git's output scales with the
// REPOSITORY rather than with the question asked: `ls-files` crosses it at tens
// of thousands of tracked files, and `git diff <merge-base>` crosses it on an
// ordinary feature branch a few hundred commits behind its base. Past the bound
// spawnSync kills git and throws `spawnSync git ENOBUFS`, naming neither the
// argv nor the limit -- an operator gets a bare errno for what is really "your
// base is far behind". Routing every capture through here raises the bound once
// and makes the refusal past it legible.

import { execFileSync } from 'node:child_process';

export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// Callers branch on the condition rather than matching the message, which they
// no longer control: the throw below replaces it.
export function isEnobufs(err) {
  return err?.code === 'ENOBUFS';
}

// `maxBuffer` is injectable only so a test can drive the refusal path without
// generating a quarter-gigabyte of git output; nothing in the shipped path
// passes it.
export function gitCapture(cwd, args, { input, maxBuffer = GIT_MAX_BUFFER } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input,
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      maxBuffer,
    });
  } catch (err) {
    // Only the buffer overflow is rewritten -- every other failure is re-thrown
    // untouched, because callers build their own diagnosis out of git's
    // status/stdout/stderr (a bad ref in candidates.mjs, a rejected patch in
    // sites.mjs). Those same callers read the rewritten error, so what it
    // carries matters: git's own fields come along, but its EMPTY stderr does
    // not -- a caller falling back from `err.stderr` to `err.message` treats ''
    // as an answer and would print a blank where the message below belongs.
    if (!isEnobufs(err)) throw err;
    const failure = new Error(
      `git ${args.join(' ')} in ${cwd} produced more output than the ${maxBuffer}-byte capture limit, `
      + 'so none of it could be read',
    );
    failure.code = 'ENOBUFS';
    failure.status = err.status;
    failure.stdout = err.stdout;
    if (err.stderr?.length) failure.stderr = err.stderr;
    throw failure;
  }
}
