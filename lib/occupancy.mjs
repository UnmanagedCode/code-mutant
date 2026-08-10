// WHO IS IN THIS WORKSPACE, AND WHAT DID CODE-MUTANT LEAVE IN IT.
//
// The runner already gives each worker its own copy (runner.mjs keys the
// workspace on the worker ordinal). This module exists because that argument --
// "each worker owns its own copy, so nothing is shared" -- was written in this
// codebase and was already wrong once: cards 2026-0010 and 2026-0029. A
// correct-by-construction claim about concurrency is not a guarantee, so the
// claim is asserted here instead of trusted.
//
// Two assertions, both of which the runner turns into ERROR and never into a
// verdict. That direction matters: the race produced a false SURVIVED (a finding
// an implementer would have chased) and, symmetrically and silently, would
// produce a false KILLED. When isolation is in doubt nothing is known about
// coverage, so the honest output is "no verdict", not a weaker verdict.
//
//   claim()    exclusive occupancy. A second concurrent claim is a runner bug.
//   residue()  the paths code-mutant has written here still hold the bytes they
//              had before it first wrote them. This is what catches the OTHER
//              half of the field report: a mutant whose own sites are perfectly
//              intact, running against another mutant's leftover edit in a
//              different file, and failing tests that cannot reach its site.
//
// Byte comparison is verifySnapshot's, not a second implementation -- including
// its treatment of ABSENT as a state to verify rather than a missing entry.

import { verifySnapshot } from './snapshot.mjs';

export class OccupancyError extends Error {}

export function createOccupancy(root) {
  let holder = null;
  // rel -> { content }, the FIRST-SEEN pre-mutation state. First-seen, not
  // latest: a path re-snapshotted by a second mutant would otherwise have its
  // ledger entry overwritten with bytes that already carry residue, which is
  // precisely the substitution that made the field bug invisible.
  const originals = new Map();

  return {
    root,
    holder() { return holder; },

    claim(label) {
      if (holder !== null) {
        throw new OccupancyError(
          `workspace ${root} is already occupied by ${holder}, so ${label} cannot run in it: two mutants `
          + 'in one tree interleave their snapshot and restore, and no verdict from either is interpretable',
        );
      }
      holder = label;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          holder = null;
        },
      };
    },

    // Called with a snapshot the runner has already captured, so the ledger costs
    // no extra reads.
    record(snapshot) {
      for (const [rel, entry] of snapshot.entries) {
        if (!originals.has(rel)) originals.set(rel, { content: entry.content });
      }
    },

    residue() {
      return verifySnapshot({ root, entries: originals });
    },
  };
}
