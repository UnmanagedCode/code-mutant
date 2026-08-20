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
Your own writes stay in gitignored `.mutation/` — except the mutation itself: under `in-place`
isolation it is applied to the worktree you share with the implementer and byte-restored after
every mutant. A read-only brief doesn't stop you here.

## 1. Enumerate claims

List the coverage claims to attack: what the implementer stated it pinned, plus the invariants the
diff's *new* tests are named for. Never invent a claim that isn't backed by an actual test, and
never accept a claim as proven without mutating it yourself.

## 2. Gate

Run `baseline` in the isolation mode `config.json` sets, and every mutant in that same mode — pass
no `--copy`/`--in-place` of your own unless the project's `harness/mutation/README.md` directs it,
since a mode the project didn't configure can fail its baseline gate outright. The harness is
trustworthy for this run only when clean-tree and baseline both pass *and* the canary comes back
`KILLED`; `run` additionally gates on empty-diff-vs-base. A gate reading `not-established` did not
run — never read
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
`mutants.schema.md` — the catalog's authoritative schema. Leave `expectFail` empty and run
`run --all --learn` first: it reports each mutant's failing set without grading, so you fill
`expectFail` from what actually failed instead of guessing and paying an `IMPRECISE` re-run. Then
run `validate`: it resolves every
site against the current tree in about a second and flags stale anchors and mutants that can never
read `KILLED`, but it runs no tests, so it establishes no gate and does not stand in for step 2.

## 6. Run

Run narrow by default. A structural mutation with no anchor+replace form (e.g. reordering two
migrations) uses the `patch` site form instead — that residue stays hand-authored, the runner
doesn't invent structural edits for you, but `probe --patch-file` iterates one without a catalog
entry and `probe --id` re-runs a single existing entry under probe's relaxed gates. If a run is
interrupted, re-run it with `--resume` rather than restarting: completed verdicts are reused instead
of re-measured. For exact
command syntax, `mutate.mjs --help` or the project's `harness/mutation/README.md` is authoritative.

## 7. Interpret

- `SURVIVED` → blocking finding. Diagnose why: the test asserts at the wrong layer, a fixture omits
  the very key the bug destroys, or the invariant is double-guarded (re-run as a multi-site mutant
  against the same claim before reporting).
- `IMPRECISE` → the mutant itself is invalid (too broad, or an equivalent mutant) — rewrite it
  smaller and re-run; don't report it as a finding. When more than one needs re-authoring, fix them
  all and re-run **once**: a re-run re-pays the gates (~91% of a rework round), so N separate
  re-runs pay that N times.
- `TIMEOUT` → the mutation hung the scope: the same scope completed unmutated moments earlier, so
  rewrite the mutant smaller. A hung *unmutated* scope arrives as `ERROR` instead — next bullet.
- `ERROR` → a harness or catalog problem (stale anchor, unusable scope) — fix or drop the mutant,
  not a coverage finding either. **One exception:** `reason: scope-timed-out` means the *unmutated*
  scope did not terminate — report that project defect upward and do **not** rewrite or drop the
  mutant, which cannot fix it. Never read any `ERROR` as a survivor: `graded: false` and
  `failedTests: null` mark it (`mutants.schema.md#the-shape-of-an-ungraded-result`).

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
