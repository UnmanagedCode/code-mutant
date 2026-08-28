# Demand mutation-verified coverage

One evidence form added to the review→refine loop: a **prover** mutation-proves "covered" claims.

- **Spawn a dedicated prover to run `/code-mutant:prove`** against the implementer's coverage
  claims — never the implementer, never an extra duty on a lens reviewer's brief. It is a role,
  not a stage — don't look for one named after it; spawn it into whatever slot your workflow opens
  for a worker beside the implementer, and brief it write-and-restore, not inspect-only, since it
  mutates the shared worktree and byte-restores after each measurement. **One per round**: the
  runner's concurrency guard is per-process, so two provers mutate one tree undetected.
- **Trust the runner's non-zero exit for un-waived survivors over the prover's self-reported
  verdict**, and hold its every verdict to "a test that passes either way proves nothing."
- **Brief the implementer too** — have it state which invariant each test pins, and nothing
  further: that statement is its whole coverage duty, and the claims will be independently
  mutated, not re-read. Have it commit before the prover starts, and relay a dirty-worktree
  refusal back to it rather than waiving the gate — the prover can't commit on its behalf.
- **Never brief the implementer to break source to watch a test fail** — no mutating, reverting,
  stubbing or perturbing, wherever the mutant lives; a path-scoped ban ("don't touch
  `.mutation/`") is not this ban, since one told to prove its tests fail hand-rolls mutants under
  `/tmp` and satisfies it exactly. Test-first ordering is the sanctioned alternative — afterwards
  only a mutant produces the unfixed behaviour.
- **Arbitrate survivors like any other review finding** — a `SURVIVED` verdict is one to weigh,
  not an automatic block. Relay what's worth fixing as the invariant that needs a test, never as a
  mutant to re-run, and waive the rest explicitly or the prover re-reports them every round.
- **A timed-out run keeps its verdicts, so replacing a wedged prover forfeits nothing.** A hang
  the runner blames on the suite is a project defect for the implementer, not a mutant to rewrite.
- **No `harness/mutation/config.json` means the project is configured for no mutation testing** —
  the prover notes it and the review proceeds; never brief a bootstrap or a by-hand mutation into
  a review, since opting a project in is separate owner-directed work against `code-mutant`'s
  `scaffold/harness.md`.
