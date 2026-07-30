# Demand mutation-verified coverage

This adds one form of evidence to the canonical review→refine loop: a reviewer must
mutation-prove a "covered" claim before anyone trusts it.

- **Mutation-prove, don't trust the report** — brief the reviewer to run `/code-mutant:prove`
  against the implementer's coverage claims; the implementer is the wrong owner for target
  selection.
- **Trust the runner's non-zero exit for un-waived survivors over the reviewer's self-reported
  verdict** — expect an independent baseline re-measurement too, not a reused number, and hold
  every claim to "a test that passes either way proves nothing."
- **Brief the implementer too** — state each coverage claim precisely (which invariant each test
  pins), because it will be independently mutated, not re-read.
- **Arbitrate survivors like any other finding** — a `SURVIVED` verdict is a finding to weigh, not
  an automatic block; relay what's worth fixing, and say so explicitly when something isn't, so the
  reviewer marks it waived — left unwaived, it's re-reported every round.
- **Handle the no-harness case** — brief a bootstrap worker from `code-mutant`'s
  `scaffold/harness.md`, or proceed the review without mutation proof; a missing harness is a gap
  to fill or knowingly skip, not a blocking error.
