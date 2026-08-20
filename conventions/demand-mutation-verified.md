# Demand mutation-verified coverage

This adds one form of evidence to the canonical review→refine loop: a reviewer must
mutation-prove a "covered" claim before anyone trusts it.

- **Mutation-prove, don't trust the report** — brief the reviewer to run `/code-mutant:prove`
  against the implementer's coverage claims; the implementer is the wrong owner for target
  selection. Brief it write-and-restore, not read-only — the mutant is applied to the tree and
  byte-restored after each measurement.
- **Trust the runner's non-zero exit for un-waived survivors over the reviewer's self-reported
  verdict** — expect an independent baseline re-measurement too, not a reused number, and hold
  every claim to "a test that passes either way proves nothing."
- **Brief the implementer too** — state each coverage claim precisely (which invariant each test
  pins), because it will be independently mutated, not re-read. Have it commit its work before
  review starts, and relay a dirty-worktree refusal back to it rather than waiving the gate — the
  reviewer can't commit on its behalf.
- **Arbitrate survivors like any other finding** — a `SURVIVED` verdict is a finding to weigh, not
  an automatic block; relay what's worth fixing, and say so explicitly when something isn't, so the
  reviewer marks it waived — left unwaived, it's re-reported every round.
- **Relay survivors as invariants, never as mutants to re-run.** A finding is relayed as an invariant that needs a test; handing the implementer the mutants to re-run puts the gate under the party whose verdict can't be independent anyway.
- **Keep non-vacuous test verification with the implementer, mutation artifacts with the reviewer** — brief the implementer to confirm each new test fails against the unfixed behaviour and to state which test pins which invariant, and never to author, run, or touch `.mutation/`.
- **A timed-out mutation run keeps its completed verdicts; arbitrate a hang by blame.** Re-prompting
  or replacing a wedged reviewer no longer forfeits the run — the verdicts already earned survive and
  the next attempt reuses them, so that call is about the worker, not about salvaging its work. A hang
  the runner blames on the suite is a project defect to route to the implementer, not a mutant for the
  reviewer to rewrite; the reviewer's side is `/code-mutant:prove` step 7.
- **Handle the no-harness case** — brief a bootstrap worker from `code-mutant`'s
  `scaffold/harness.md`, or proceed the review without mutation proof; a missing harness is a gap
  to fill or knowingly skip, not a blocking error.
