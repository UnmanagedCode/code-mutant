# Demand mutation-verified coverage

When a review is judging whether a claimed fix is actually covered, this is the same canonical
review→refine loop — it just adds one more form of evidence a reviewer must gather before you trust
a "covered" claim.

- **Mutation-prove, don't trust the report** — brief the reviewer to run `/code-mutant:prove`
  against the implementer's coverage claims. The implementer is the wrong owner for target
  selection: left to itself it only ever mutates what its own tests already catch.
- **The reviewer's run is the evidence** — not its summary. Expect an independent baseline
  re-measurement, not a reused number, and hold every claim to "a test that passes either way
  proves nothing." Trust the mutation runner's exit code over a reviewer's self-reported verdict —
  a sentinel has emitted `REVIEW_CLEAN` alongside confirmed regressions before; a non-zero exit for
  un-waived survivors can't lie the same way.
- **Brief the implementer too** — state each coverage claim precisely (which invariant each test
  pins), because it will be independently mutated, not re-read. This instruction has no other home
  now that there's no project-scope fragment.
- **Arbitrate survivors like any other finding** — a `SURVIVED` verdict blocks on its own terms;
  relay what's worth fixing, and say so explicitly when something isn't, so the reviewer marks it
  waived — left unwaived, it's re-reported every round.
- **Handle the no-harness case** — brief a bootstrap worker from `scaffold/harness.md`, or proceed
  the review without mutation proof; a missing harness is a gap to fill or knowingly skip, not a
  blocking error.
