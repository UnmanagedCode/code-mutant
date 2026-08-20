# `mutants.json` — the per-review mutant catalog

**This file is the authoritative format.** Anything else that describes the catalog defers here.

**Location:** `.mutation/mutants.json`, in the worktree under review.
**Lifetime:** one review loop. Gitignored, owned by the reviewer, deleted with the worktree.
**Why ephemeral:** a mutant is scaffolding that proves a test stands. Once proven, the *test* is the
durable artifact. Anchors are coupled to exact source text, so a committed catalog turns into a
stream of stale-anchor `ERROR`s on invariants nobody is currently reviewing.

`run` refuses to write anything under `.mutation/` unless that directory is gitignored — see
[Refusals](#refusals).

## Top level

Either a bare array of mutants, or an object with a `mutants` array:

```json
{ "mutants": [ { "id": "…" } ] }
```

Ids must be unique within the file.

## Per-entry fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Stable handle for `run --id`. Re-runnable in round N+1 of the same review. |
| `invariant` | yes | string | **Prose.** What property this mutant violates. Mutants are named by invariant, never by "line 42" — a bare `line <n>` is rejected. |
| `sites` | yes | array | One or more edits, applied **simultaneously**. An array because a double-guarded invariant needs multi-site mutation to be observable at all. |
| `expectFail` | counted mode | string[] | Test references that *should* fail. `KILLED` means exactly these failed. |
| `expectPass` | no | string[] | Test references that must keep passing. A failure here is `IMPRECISE`, not `KILLED` — kill *precision* is the point, not kill/no-kill. |
| `whyNotEquivalent` | yes | string | Why the change genuinely alters behaviour rather than being an equivalent mutant. Required because equivalence is semantic and the runner cannot decide it; writing it down is the author's job. |
| `narrowCommand` | no | string | Overrides the `{tests}`-substituted `testCommand` for this mutant, verbatim. The way an exit-code gate gets narrowed. |
| `narrowTo` | no | `"file"` \| `"names"` | Narrowing granularity. Default `"file"`. See [Narrowing](#narrowing). |
| `waived` | no | `{ "reason": string }` | Records a conductor decision not to fix this survivor. Waived mutants still run and report separately; they do not affect the exit code. |

Unknown fields are ignored, so a reviewer may keep notes alongside an entry.

## Site forms

A site is **either** an anchor swap **or** a patch. Never both in one site, and never both forms
touching the same file within one mutant (a patch's context lines are written against the unmutated
file, so combining them would either reject the patch or land an edit the author did not write).

### Anchor + replacement

```json
{ "file": "src/guard.mjs", "anchor": "kind === 'user-defined'", "replacement": "false" }
```

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | Path relative to the repository root. |
| `anchor` | yes | Exact substring. **Must match exactly once** — 0 or >1 matches is `ERROR`, never a best-effort edit. |
| `replacement` | yes | Replacement text. Must differ from the anchor; a no-op is refused because it would read `SURVIVED` and manufacture a false finding. |

Two sites in the same file are applied in one pass, computed against the original text. Overlapping
anchors are refused.

### Patch

```json
{ "patch": "diff --git a/db/migrate.mjs b/db/migrate.mjs\n--- a/db/migrate.mjs\n+++ b/db/migrate.mjs\n@@ -1,3 +1,3 @@\n…" }
```

A unified diff applied with `git apply` (forward only). For structural mutations an anchor cannot
express — reordering one migration relative to another, disabling a rule cleanly. Supported in
**both** isolation modes: such mutations land in server/DB projects, which are exactly the ones that
need `in-place`.

The affected path set is derived from the patch (`git apply --numstat` and `--summary`, plus a direct
parse of the diff headers) and every path is snapshotted **including its absence**, so a patch that
creates a file has that file deleted on restore, and one that deletes a file has it recreated
byte-identical. The two derivations are unioned; a disagreement is reported rather than swallowed.

Some mutations stay hand-driven. The runner does not invent structural edits.

## Test references

A test reference identifies one test to the adapter. Format is per adapter, because the identifier
each runner prints is the one a reviewer should write:

| Adapter | Reference | Default narrowing scope |
|---|---|---|
| `node-test` | `test/guard.test.mjs::allows ollama` — the **leaf** test name, as `node --test` prints it | the file |
| `pytest` | `tests/test_math.py::TestGroup::test_inner` — a real pytest nodeid | the file |
| `vitest` | `test/math.test.js::nested > inner failure` — the full nested name path, as vitest prints it | the file |
| `dotnet` | `proj.UnitTest1.Subtracts` — the fully-qualified name. **No file**, because `dotnet test` output carries none | the declaring type (`proj.UnitTest1`) |
| `exit-code` | not used — there are no named tests | whole command |

Matching is on the exact string, after trimming and stripping a leading `./`. A reference naming
only a file matches only a **file-level** failure (a module that failed to load), never "any failure
in that file" — treating it as a wildcard would quietly weaken what `KILLED` means.

Under `--learn`, `expectFail`/`expectPass` are read **only** as narrowing scope and are never
compared against the observed failures — grading is suppressed entirely, so a bogus or stale ref
never buys a bogus `IMPRECISE`.

## Narrowing

`{tests}` in `testCommand` is substituted with the smallest scope that **both** (i) includes every
`expectFail` ∪ `expectPass` test **and** (ii) still lets the adapter observe failures *outside*
`expectFail` within that scope. In practice: file granularity.

Condition (ii) is load-bearing. Running exactly `expectFail ∪ expectPass` would make "a failure
outside `expectFail`" unobservable by construction, silently gutting `IMPRECISE` — the verdict that
catches equivalent mutants.

`narrowTo: "names"` opts one mutant into name-level narrowing. It exists because the runner cannot
detect that a file "holds tests the reviewer deliberately excludes" — only the author can state it.
**Consequence:** for that mutant, `IMPRECISE` detection shrinks to the `expectPass` set alone, and
the report labels it. Use it when the adapter can name-filter and the file holds tests you are
deliberately leaving out; otherwise leave it at the default.

In exit-code mode there is no substitution — the whole gate command runs.

Learn mode only: a mutant with no `expectFail`/`expectPass` at all falls back to `baselineCommand`
(the whole suite) instead of refusing — discovery has no scope to narrow to.

## Refusals

The runner refuses rather than guessing. Each produces `ERROR` for that mutant (or a usage error
before the run):

| Code | Cause |
|---|---|
| `anchor-missing` | The anchor is not in the file — the catalog is stale against moved code. |
| `anchor-ambiguous` | The anchor matches more than once, so the edit is not well defined. Extend it. |
| `no-op` | `replacement` equals `anchor`, or the combined edit leaves the file unchanged. |
| `file-missing` | An anchor site's `file` does not exist. |
| `overlapping-anchors` | Two sites of one mutant overlap in the source. |
| `mixed-site-forms` | An anchor site and a patch site of one mutant touch the same file. |
| `patch-unparseable` / `patch-rejected` | git could not read the patch, or it does not apply. |
| `scope-non-green` | The narrowed scope was already failing, or exited non-zero, before any mutation. |
| `scope-timed-out` | The narrowed scope was killed at its deadline **before any mutation** — `hang.blame: "suite"`, a project defect rather than a mutant to rewrite. |
| `scope-empty` | The narrowed scope ran **zero tests**. Never reported as `SURVIVED`. |
| `unexplained-exit` | Counted mode: the command exited non-zero while naming **no failing test** — something the adapter cannot see went wrong, so the run is not observably green. Never reported as `SURVIVED`. |
| `canary-not-established` | Exit-code mode: the gate could not be shown to observe a deliberate break in the mutated file, so its "survivor" means nothing. |
| `timed-out` | The command exceeded `timeoutMs`. |
| `dirty-tree` | Trust gate, `baseline`/`run` (before baseline and canary): the worktree has uncommitted or untracked-and-not-gitignored changes. `--allow-dirty` overrides it; `probe` only warns. See [The clean-tree gate](#the-clean-tree-gate). |
| `empty-diff-vs-base` | Trust gate, `run` only: `baseBranch` is configured, distinct from the branch HEAD is on, and there is no diff against it — nothing committed to mutate. See [The clean-tree gate](#the-clean-tree-gate). |
| `base-unresolvable` | Trust gate, `run` only: `baseBranch`/`--base` does not resolve to a real branch or commit. A gate failure, not a process exit — a typo'd branch name must read the same as any other trust-gate failure. |
| — | Writing under `.mutation/` when it is not gitignored is a **hard stop** (exit 4), not a warning: this run would otherwise leave visible untracked files in a worktree it does not own and cannot commit a fix to. |

## Pre-flight validation

`validate` resolves every catalog site against the working tree and **runs no test**. It exists
because the runner orders baseline → resolve → canary, so a stale anchor otherwise costs a whole
baseline to discover, once per stale anchor per iteration.

**It is not a gate.** It measures nothing, so it establishes neither clean-tree, baseline nor canary,
and it emits no verdict. Exit `0` means *every catalog mutant resolves against this tree* — never
*the gates passed*. Exit `4` (the ordinary catalog-error code — this adds no new exit code) means at
least one **problem**.

Two severities, and the split is a contract you may script against:

| Severity | Meaning | Affects exit code |
|---|---|---|
| `problem` | `run` could not produce a trustworthy verdict for this mutant. Either the runner's own code refuses it — validate reports that by *calling that same code*, never by re-deciding it — or the mutant is structurally incapable of `KILLED`. | Yes → exit 4 |
| `warning` | validate's own advice. `run` proceeds; something is degraded. | **Never** |

| Code | Severity | Cause |
|---|---|---|
| every code in [Refusals](#refusals) that `resolveSites` raises (`anchor-missing`, `anchor-ambiguous`, `no-op`, `file-missing`, `overlapping-anchors`, `mixed-site-forms`, `patch-unparseable`, `patch-rejected`, `invalid-site`) | problem | Reported verbatim from `resolveSites` — the same call `run` makes. |
| `no-expect-fail` | problem | Counted grade with no `expectFail`. Such a mutant **can never read `KILLED`**: if the mutation survives it reports an un-arbitrable `SURVIVED` (nothing was claimed to fail, so the survivor block has no test to point at), and if anything catches it, `IMPRECISE`. `probe` already refuses the same shape outright. Run `run --learn` to discover the failing set and fill `expectFail` from it. |
| `no-narrow-scope` | problem | `planNarrowing` refused — references are present but none yields a scope. |
| `mutation-dir-not-ignored` | problem | Catalog-level. `.mutation/` is not gitignored, which `run` hard-stops on. |
| `ref-file-missing` | warning | The adapter's references name files and `scopeOf(ref)` — the exact string narrowing substitutes — is not a path in this tree. |
| `ref-shape` | warning | The adapter's references do **not** name files (`dotnet`, `exit-code`) but a reference is written `file::name`. |
| `refs-ignored` | warning | Exit-code grade with `expectFail`/`expectPass` listed; at that grade the verdict is the command's exit status and those entries are never consulted. Scope with `narrowCommand` instead. |
| `narrow-downgraded` | warning | `narrowTo: "names"` will not take effect; carries the downgrade reason. |

Nothing reaches the `problem` tier on the strength of a reading of the source — only what the runner
itself refuses, plus `no-expect-fail`, whose verdicts were observed. A false `problem` blocks a
review over a catalog that would have run fine, which is worse than a missing check.

## The clean-tree gate

The third trust gate, alongside baseline and canary: mutation must run against committed state, so a
survivor is re-runnable against a sha by anyone, and a restore bug degrades from destroying
unrecoverable work to a recoverable git object. Two independent checks, both run before baseline and
canary:

- **dirty-tree** (`baseline` and `run`; `probe` warns instead of refusing) — refuses when
  `git status --porcelain` reports anything. That already excludes gitignored paths by default, so a
  gitignored `.mutation/` never trips it. `--allow-dirty` overrides the refusal; every verdict from
  that invocation is then labelled **non-reproducible**, in the matrix (a `repro` column reading
  `NO (dirty)`) and in `--json` (`reproducible: false`, top-level and per-result) — the same way an
  exit-code-mode verdict is labelled with its weaker grade.
- **empty-diff-vs-base** (`run` only) — compares `baseBranch` (`harness/mutation/config.json`, or
  `--base` to override it per invocation) against the working tree. A gate that did not run must never
  read the same as one that passed, so this is `NOT-ESTABLISHED` — not a refusal, not `PASSED` — when
  either: no `baseBranch` is configured, or it names the branch HEAD is already on (comparing a branch
  to itself would refuse every run made directly on that branch, which is a false refusal, not a
  finding). Only when `baseBranch` is configured AND distinct does an empty diff become the hard
  `empty-diff-vs-base` refusal. A `baseBranch`/`--base` that does not resolve to a real branch or
  commit is its own `base-unresolvable` gate failure, not a process exit -- every gate failure
  produces the same structured record.

Neither check relaxes the restore contract: no git operation is ever used for restore, and copy mode
still copies the working tree rather than cloning from HEAD. The precondition can be violated (dirty,
or no base configured), so correctness must not depend on it — these checks only make that state
visible rather than silently trusted.

The mutated sha (`report.mutatedSha`, `git rev-parse HEAD`) is recorded on every report so a survivor
finding can be pointed at exactly the commit it was found against.

## Worked example

```json
{
  "mutants": [
    {
      "id": "backend-generalisation",
      "invariant": "the generalized user-defined-backend branch is load-bearing, not decorative",
      "sites": [
        {
          "file": "src/guard.mjs",
          "anchor": "return kind === 'user-defined';",
          "replacement": "return false;"
        }
      ],
      "expectFail": ["test/guard.test.mjs::allows user-defined backends"],
      "expectPass": ["test/guard.test.mjs::allows ollama"],
      "whyNotEquivalent": "returning false denies a backend the guard is specified to admit; the ollama path is unaffected, so this isolates the generalisation rather than the guard as a whole"
    },
    {
      "id": "double-guarded-timeout",
      "invariant": "the timeout is enforced, not merely configured (guarded in two places)",
      "sites": [
        { "file": "src/pool.mjs", "anchor": "timeoutMs ?? 30_000", "replacement": "0" },
        { "file": "src/worker.mjs", "anchor": "if (elapsed > timeoutMs)", "replacement": "if (false)" }
      ],
      "expectFail": ["test/pool.test.mjs::kills a hung worker"],
      "whyNotEquivalent": "either guard alone keeps the test green, so a single-site mutant would read SURVIVED for the wrong reason; disabling both is what makes the claim testable",
      "waived": { "reason": "conductor 2026-07-30: pool rewrite lands next sprint, not worth pinning twice" }
    }
  ]
}
```

---

# Appendix A — the `--json` report contract

`run` and `probe` emit this on stdout with `--json`, and write the same object to
`.mutation/results/<runId>.json`.

```
{
  schemaVersion: 1,
  command:   "run" | "probe" | "baseline",
  isolation: "in-place" | "copy",
  jobs:      number,
  workspaceRoot: string,
  adapter:   { name, grade: "counted"|"exit-code", modulePath },
  learn:         boolean,         // true when --learn suppressed grading for this run
  mutatedSha:    string|null,     // `git rev-parse HEAD` -- points a survivor at a re-runnable commit
  reproducible:  boolean,         // false only when --allow-dirty was used to proceed on a dirty tree
  gates: {
    cleanTree: { outcome: "passed"|"failed", code: "dirty-tree"|null, dirty, allowedDirty, detail },
    baseDiff:  { outcome: "passed"|"failed"|"not-established", code: "empty-diff-vs-base"|"base-unresolvable"|null,
                 base, currentBranch, mergeBase, detail },   // `run` only
    baseline: { outcome: "passed"|"failed", command, counts: {passed,failed,skipped,ran}|null, exitCode,
                failedTests: [string]|null, durationMs, timedOut, detail },   // failedTests: null when nothing is nameable
                                                         // (exit-code grade, or a FAILED baseline with no parsed
                                                         // failure to name); [] only when green
    canary:   { outcome, status: "KILLED"|"FAILED"|"NOT-ESTABLISHED", grade, target, durationMs,
                attempts: [ { target, durationMs, why } ],   // every candidate tried and why it did not fire
                detail }
  },
  narrowBaselines: [ { command, green, counts, durationMs } ],   // one entry per DISTINCT narrow scope
  timings: { totalMs, gatesMs, narrowBaselinesMs, mutantsMs },
  results: [ {
    id, invariant, whyNotEquivalent, waived,
    verdict: "KILLED"|"SURVIVED"|"IMPRECISE"|"TIMEOUT"|"ERROR"|"LEARNED",
    reason,                       // machine-readable refusal/imprecision code, or null
    detail,                       // one human sentence
    grade,                        // WHICH SIGNAL GRADE PRODUCED THIS VERDICT
    reproducible,                 // same run-level value as above, copied onto every result
    narrowing: { mode: "file"|"names"|"command"|"whole", command, scopes,
                 requestedNames, downgradeReason, placeholder },
    mutation:  [ { kind: "anchor", file, edits: [{anchor, replacement, line}] }
               | { kind: "patch",  paths, patch, pathSet } ],
    expectFail, expectPass,
    failedTests, unexpectedFailures, missingFailures,
    narrowBaseline: { command, green, counts },   // the like-for-like delta reference
    mutantCounts:   { passed, failed, skipped, ran },
    delta:          { passed, failed, skipped },
    canary,                       // exit-code mode only: the per-mutant gate, when one was needed
    exitCode, durationMs,
    applyMs, measureMs, restoreMs,  // this mutant's three phases; each null for a phase that never ran
    deadlineMs,                     // the wall-clock cap this mutant's command actually got
    hang: { blame: "mutation"|"suite", deadlineMs, referenceMs } | null   // non-null ONLY on a deadline kill
  } ],
  noTrace: { ok, before, after } | null,
  pathSetMismatches: [ … ],
  summary: { total, open, waived, survivors, waivedSurvivors, noVerdict, errored, timedOut,
             killed, imprecise, learned },   // errored + timedOut === noVerdict
  exitCode: number
}
```

`narrowBaseline.counts` is the **same scope measured unmutated**, memoised per resolved command
string. It exists so `delta` compares like with like: the global baseline runs the whole suite while
a mutant runs a narrowed scope, so comparing those two would show the narrowing, not the mutation.

## Where a run's wall time went

Every measured command reports its own `durationMs`, and `timings` is **derived** from those — it
sums nothing that is not also on the report, so the breakdown cannot drift from the numbers it
sums.

| Field | Covers |
|---|---|
| `timings.totalMs` | The whole invocation, including a run that stopped at a failed gate. |
| `timings.gatesMs` | `gates.baseline.durationMs + gates.canary.durationMs`. The **fixed** cost — paid once per invocation regardless of mutant count. |
| `timings.narrowBaselinesMs` | Sum of `narrowBaselines[].durationMs` — one measured command per *distinct* scope, so N mutants at one scope cost one entry. |
| `timings.mutantsMs` | Sum of `results[].durationMs`. A **sum of per-mutant wall clocks**, so under `jobs > 1` it legitimately exceeds `totalMs`. |
| `results[].applyMs` / `measureMs` / `restoreMs` | The harness's own snapshot+apply and restore cost, versus the project's command. Disjoint slices of that result's `durationMs`; `null` for a phase that never ran (an `ERROR` that stopped before Phase B). The remainder, when there is one, is the per-mutant exit-code canary — its own cost is on `results[].canary.durationMs`. |
| `gates.canary.attempts[].durationMs` | Each entry is a **whole `baselineCommand` run** against a candidate that did not fire. Up to 5 candidates are tried, so a project whose early candidates sit outside its `baselineCommand`'s scope pays that multiple before the gate establishes anything. |

## Deadlines and hang blame

`timeoutMs` is the **ceiling**. A measured command that has a **like-for-like unmutated reference**
gets a tighter deadline derived from it instead; only a command with no reference falls back to the
ceiling. `results[].deadlineMs` is what the command actually got.

| Command | Reference | Deadline |
|---|---|---|
| global baseline | none | `timeoutMs` |
| narrow baseline | none | `timeoutMs` |
| canary attempt (`scope: 'baseline'`) | the global baseline's `durationMs` — same command | derived |
| mutant run | that scope's narrow-baseline `durationMs` — same command | derived |
| per-mutant canary (`scope: 'mutant'`) | that scope's narrow-baseline `durationMs` | derived |
| `setup` / `teardown` hooks | none | `timeoutMs` |

Derivation and the `hang` config key are documented once, in the README's config table.

`hang` is non-null **only** when a command was killed at its deadline, and `blame` is sound without
any extra run:

- **`mutation`** — the mutant run was killed. Reaching it required the *same command* to have been
  measured unmutated and green, so the only thing that changed is the mutation. Verdict `TIMEOUT`.
- **`suite`** — the **narrow baseline itself** was killed, before any mutation was applied. Verdict
  `ERROR` with reason `scope-timed-out` (never `TIMEOUT`: a mutation that was never measured cannot
  be blamed), and `referenceMs` is `null` because a narrow baseline has none.

`gates.baseline.timedOut` is the same signal one level up, for a hang at the gate.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No un-waived survivors, every mutant produced a verdict, gates passed. |
| 1 | At least one **un-waived survivor** — a coverage claim is false. |
| 2 | A trust gate failed (clean-tree, empty-diff-vs-base, baseline, or canary); no verdict is interpretable. |
| 3 | Restore or the clean-tree assertion failed — inspect the tree by hand. |
| 4 | Usage, config, or catalog error. |
| 5 | No survivors, but some mutant produced **no verdict** (`ERROR`/`TIMEOUT`) — not a clean proof. |

Code 5 exists so a catalog whose mutants all fail to resolve cannot read as "0 survivors, clean".

A learn run's exit 0 means discovery completed, never that coverage was proven — check the report's
`learn` flag before reading an exit code from a `--learn` invocation as a clean sweep.

## The `validate` report

`validate --json` emits a **different shape**, deliberately carrying no `results`, `gates`,
`verdict` or `survivors` key, so a consumer keyed to the run report above cannot read one as the
other:

```
{
  schemaVersion: 1,
  command: "validate",
  ranTests:         false,      // always -- validate executes nothing
  gatesEstablished: false,      // always -- exit 0 is "the catalog resolves", not "the gates passed"
  note, catalog,
  adapter: { name, grade, modulePath },
  issues:  [ { severity: "problem"|"warning", code, detail } ],   // catalog-level
  mutants: [ {
    id, invariant,
    sites,      // same shape as a run report's `mutation`, or null if resolution failed
    issues,     // as above, per mutant
    resolves    // false iff this mutant has a problem
  } ],
  summary: { total, resolves, withProblems, problems, warnings },
  exitCode: 0 | 4
}
```

See [Pre-flight validation](#pre-flight-validation) for the per-code severity table.

---

# Appendix B — the adapter `parse()` contract

`runner: "custom"` loads `parse.mjs` from **beside `config.json`** (i.e. `harness/mutation/parse.mjs`)
and calls:

```js
export function parse(stdout, stderr, exitCode) { … }
```

It must return:

| Field | Type | Meaning |
|---|---|---|
| `grade` | `"counted"` \| `"exit-code"` | Defaults to `"counted"`. |
| `passed` / `failed` / `skipped` | number | Counts from this run. Reporting zero failures while the command exited non-zero makes the mutant `ERROR` (`unexplained-exit`), never `SURVIVED` — the counters alone are not taken as green. |
| `ran` | number | Tests the command actually reported, **including skipped**. `0` makes the mutant `ERROR` (`scope-empty`), never `SURVIVED`. |
| `failedTests` | `[{ file, name, id }]` | `id` is what `expectFail`/`expectPass` are compared against. |
| `compileError` | boolean | True for a build/module-load break. Yields `IMPRECISE`. Never guess it from an exit code alone. |
| `counts` | object | Free-form extras, carried into the report. |

Optional exports, each with a safe default if omitted: `scopeOf(ref)` (default: the file part),
`substitute({scopes, refs, mode})` (default: space-joined quoted paths), `canNameFilter` (default
`false`), `testFilePatterns` (default `[]`), `canary(source, {file})` (default: none, which makes the
canary gate fail loudly rather than pass silently), `refsNameFiles` (whether a test reference names a
file in the repo; used only by `validate`'s reference check — default: true when you did **not**
override `scopeOf`, since you then inherit the file-part derivation, false when you did).

A project parser owns **output parsing and nothing else** — never isolation, restore, or verdict
semantics. Those must mean the same thing in every project, or the trust gates degrade into
per-project code that validates itself.
