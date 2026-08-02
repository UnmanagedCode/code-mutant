---
name: prove
description: Mutation-prove the implementer's test-coverage claims for a pending review — author real mutants against the project's mutation harness, run them, and report survivors as blocking findings. Reviewer-facing only; invoked inside the review→refine loop, never by the implementer. Invoke via /code-mutant:prove.
---

# Prove

You (the reviewer) author and run every mutant — the implementer never mutates its own claims.

## 0. A refusal stops the review

Any refusal — no `harness/mutation/config.json`, a dirty worktree, a failed gate — means stop and
report it upward to the conductor, never a clean sweep. Don't pass `--allow-dirty` to get past one,
don't commit the implementer's work to clean the tree, and don't build the harness yourself:
`harness/mutation/` is committed project state, so every one of those fixes is the implementer's.
Your own writes stay in gitignored `.mutation/`.

## 1. Enumerate claims

List the coverage claims to attack: what the implementer stated it pinned, plus the invariants the
diff's *new* tests are named for. Never invent a claim that isn't backed by an actual test, and
never accept a claim as proven without mutating it yourself.

## 2. Gate

Run `baseline` in the same isolation mode the mutants will run in. The harness is trustworthy for
this run only when clean-tree and baseline both pass *and* the canary comes back `KILLED`; `run`
additionally gates on empty-diff-vs-base. A gate reading `not-established` did not run — never read
it as a pass, and note it doesn't fail the exit code, so exit 0 alone doesn't mean the gates held
(an `exit-code`-grade harness always reports its canary that way at baseline scope, and
empty-diff-vs-base reports it whenever the project set no `baseBranch`).

## 3. Regression first

Before adding anything, re-run this review's existing catalog (`.mutation/mutants.json`) by id.
Round 1 this is a no-op (empty catalog). A mutant that was previously `KILLED` and now comes back
`SURVIVED` is a blocking finding on its own — the refine pass broke coverage that was already
proven.

## 4. Find candidates

Run `candidates` against the review's base branch to list diff hunks no catalog mutant covers yet.
**It lists, you target** — round 1 the catalog is empty so the list is the whole diff; don't
mutate one-per-hunk, that's an exhaustive sweep, not this practice. Select the hunks you judge
invariant-bearing — the ones a test claims to pin.

## 5. Author mutants

One minimal mutant per claim from step 1, and per candidate you selected in step 4: the smallest
edit that violates the invariant without breaking compilation, plus `whyNotEquivalent` stating why
the change is genuinely behavior-changing, not equivalent. For a DI or provider seam, always mutate
**both directions** — under-firing (a missed wire silently disables the guard) and over-firing (a
stale entry wedges the operation). Full per-entry format is specified in `code-mutant`'s
`mutants.schema.md` — the catalog's authoritative schema. Then run `validate`: it resolves every
site against the current tree in about a second and flags stale anchors and mutants that can never
read `KILLED`, but it runs no tests, so it establishes no gate and does not stand in for step 2.

## 6. Run

Run narrow by default. Prefer `--copy` — you don't own the shared worktree and shouldn't touch it;
fall back to `--in-place` only when a mutant's gate genuinely needs a real tree (a server boot, a
browser gate). A structural mutation with no anchor+replace form (e.g. reordering two migrations)
uses the `patch` site form instead — that residue stays hand-authored; the runner doesn't invent
structural edits for you. For exact command syntax, `mutate.mjs --help` or the project's
`harness/mutation/README.md` is authoritative.

## 7. Interpret

- `SURVIVED` → blocking finding. Diagnose why: the test asserts at the wrong layer, a fixture omits
  the very key the bug destroys, or the invariant is double-guarded (re-run as a multi-site mutant
  against the same claim before reporting).
- `IMPRECISE` → the mutant itself is invalid (too broad, or an equivalent mutant) — rewrite it
  smaller and re-run; don't report it as a finding.
- `TIMEOUT` / `ERROR` → a harness or catalog problem (hung suite, stale anchor) — fix or drop the
  mutant, not a coverage finding either.

## 8. Report

Report to the conductor: the matrix (survivors first), and a table of which claims were actually
run vs. only eyeballed. Findings only — you never commit, and the implementer receives no mutants,
only your report. Every survivor must be arbitrable without the conductor reading project code:
state the invariant claimed, the exact mutation applied, the verdict and which signal grade
produced it (counted vs. exit-code), baseline-vs-mutant counts, and which test should have failed.
("The guard isn't covered" is not arbitrable; "test T claims to pin invariant I; mutating
`<anchor>` → `<replacement>` left 221/221 green, so T passes either way" is.)

## 9. Carry waivers back

When the conductor judges a survivor not worth fixing, mark that mutant `waived` (with the reason)
in `.mutation/mutants.json` before you finish. Waived mutants still run; report them separately
from open survivors, not folded into the count.
