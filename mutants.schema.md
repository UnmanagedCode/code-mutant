# `mutants.json` — the per-review mutant catalog

**This file is the authoritative format.** Anything else that describes the catalog defers here.

**Location:** `.mutation/mutants.json`, in the worktree under review.
**Lifetime:** one review loop. Gitignored, owned by the prover, deleted with the worktree.
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

Unknown fields are ignored, so a prover may keep notes alongside an entry.

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
each runner prints is the one a prover should write:

| Adapter | Reference | Default narrowing scope |
|---|---|---|
| `node-test` | `test/guard.test.mjs::allows ollama` — the **leaf** test name, as `node --test` prints it | the file |
| `pytest` | `tests/test_math.py::TestGroup::test_inner` — a real pytest nodeid | the file |
| `vitest` | `test/math.test.js::nested > inner failure` — from the JSON report: the file relative to the repo root, then `ancestorTitles` and `title` joined with ` > `. A file that failed to load is the file alone. Requires `--reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"` | the file |
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
detect that a file "holds tests the prover deliberately excludes" — only the author can state it.
**Consequence:** for that mutant, `IMPRECISE` detection shrinks to the `expectPass` set alone, and
the report labels it. Use it when the adapter can name-filter and the file holds tests you are
deliberately leaving out; otherwise leave it at the default.

**The canary follows the narrowing.** The command that judges a mutant is the command the canary
gate is established against — see [The canary's scope](#the-canarys-scope) below.

In exit-code mode there is no substitution — the whole gate command runs.

Learn mode only: a mutant with no `expectFail`/`expectPass` at all falls back to `baselineCommand`
(the whole suite) instead of refusing — discovery has no scope to narrow to.

## Routing

A project with more than one test runner (a node backend suite plus a Vitest frontend suite, say)
writes `routes` in `config.json` instead of the top-level `runner`/`baselineCommand`/`testCommand`
— the two forms are mutually exclusive, and every other key (`isolation`, `preserve`, `timeoutMs`,
`hang`, `jobs`, `baseBranch`, `setup`, `teardown`) stays top-level and shared:

```json
{
  "routes": [
    { "name": "backend", "tests": ["tests/*.test.mjs"], "runner": "node-test",
      "baselineCommand": "node --test 'tests/*.test.mjs'", "testCommand": "node --test {tests}" },
    { "name": "frontend", "tests": ["frontend/src/**/*.test.ts", "frontend/src/**/*.test.tsx"], "runner": "vitest",
      "baselineCommand": "npx vitest run --config frontend/vitest.config.ts --reporter=json --outputFile=\"$CODE_MUTANT_REPORT_DIR/vitest.json\"",
      "testCommand": "npx vitest run --config frontend/vitest.config.ts --reporter=json --outputFile=\"$CODE_MUTANT_REPORT_DIR/vitest.json\" {tests}" }
  ]
}
```

| Rule | Detail |
|---|---|
| Route keys | Exactly `name`, `tests`, `runner`, `baselineCommand`, `testCommand`; any other key (a `test` typo) is a config error naming the allowed keys. |
| `name` | Non-empty, unique, matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (it names a report subdirectory and report lines). |
| `tests` | Non-empty array of globs in the harness's own dialect (`lib/glob.mjs`): `*` within a segment, `**/` across segments, **no braces** (refused — list `.ts` and `.tsx` separately). Mirror each runner's own discovery (e.g. Vitest's `include`). |
| `testCommand` | Must contain `{tests}`. |
| `runner` | A shipped adapter or `custom` (which loads the harness's one `parse.mjs`). Refused at load (exit 4): `exit-code` grade (no named tests, so no file to route), and any adapter whose refs do not name files (`dotnet`, or a `custom` parser overriding `scopeOf`). |

**Ref → route:** a test reference routes by its file part to the **first** route, in declared
order, whose `tests` match it. A ref matching no route is refused for that mutant (`plan-failed`
ERROR naming every route's patterns); `validate` reports it as `no-narrow-scope`.

**What runs:** every measured command is one invocation of the route driver
(`lib/route-exec.mjs`) over route/command pairs. The baseline runs every route's
`baselineCommand`; a mutant's narrowed command runs only the routes that own one of its scope files,
each with that route's own `{tests}` substitution — a route with no ref in scope **does not run**,
and `narrowing.routes` lists the ones that did. The driver runs every route even after one fails,
each in the runner's process group (a timeout kill reaches them all) with its own report subdir
`$CODE_MUTANT_REPORT_DIR/<route>/`.

**How the routes' results combine** — each route group is parsed by its own adapter and judged on
its own before the merged counters are:

| Phase | Rule |
|---|---|
| Baseline / narrow baseline | Green only when **every route group is green on its own**: no failures, no compile break, exit 0, `ran > 0`, no truncated/incomplete/spawn error. A route that ran zero tests fails it (`route "<name>": the command ran ZERO tests…`). |
| Canary | Must fire **in every route the judging command runs** — see [The canary's scope](#the-canarys-scope). |
| Mutant run | Before grading: a group that failed to start, was truncated or had incomplete output is `ERROR` (`command-failed-to-start` / `output-truncated` / `output-incomplete`); after the merged `compileError` check, a group that ran zero tests is `scope-empty` and a group exiting non-zero naming no failure is `unexplained-exit` — each detail names the route. Then the **merged** failing set is graded against `expectFail`/`expectPass` as usual. |

## The canary's scope

No mutant verdict in counted mode comes from `baselineCommand`: every verdict comes from the
mutant's narrow command, and every delta from that scope's narrow baseline. So the canary is
established against **each command that judges a mutant**, not against `baselineCommand` — the
direct form of the proposition ("this command observes a deliberate break") rather than a proxy for
it. `gates.canary.scope` says which:

| `scope` | When | What ran |
|---|---|---|
| `"narrow"` | Every pending mutant is narrow-canary-eligible | One canary per **distinct** `narrowing.command`, injected into that scope's own files |
| `"baseline"` | Nothing is eligible — including `baseline`, an empty catalog and a fully resumed run | One canary against `baselineCommand`, exactly as before: candidates discovered from `testFilePatterns`, the mutants' scopes and the journalled target |
| `"mixed"` | Both | Both of the above; `scopes[]` holds the narrow half |

A mutant is **narrow-canary-eligible** only when all of these hold. Each excluded case names a
harness that is correct and that a narrow canary would wrongly fail, so the rule fails closed:

| Condition | Why |
|---|---|
| adapter `grade !== "exit-code"` | Exit-code narrowing is `whole`, and its canary is already established per mutant against the mutant's own site file. |
| `narrowing.mode === "file"` | `"names"` prepends a name filter that **excludes the injected canary's synthesised label by construction**; `"command"` (a per-mutant `narrowCommand`) and `"whole"` name no file the gate could prove is in scope. |
| adapter `refsNameFiles === true` | The adapter's own declaration that `scopeOf(ref)` yields a repo file path (`dotnet` returns a declaring type; a custom parser overriding `scopeOf` defaults to `false`). Keyed on the declared interface, never on whether a path happens to exist. |
| `narrowing.placeholder === true` | `{tests}` was actually substituted, which is what makes "the command names its scope files" true. A `testCommand` without the placeholder runs the same thing for every mutant. |
| `narrowing.command !== baselineCommand` | The two commands resolving to one string means there is no second command to attest — a `baselineCommand` already scoped to this mutant's file, or the learn-mode no-refs fallback (which is also `mode: "whole"`). |
| ≥1 file in `narrowing.scopes` exists | A ref naming a file this tree does not have. |

**Routed harnesses: one canary per route.** Each unit above — the baseline-scope canary, and each
distinct narrow command — runs one canary **per route the command runs**, injected only into that
route's own files (discovered from the route's `tests` at baseline scope; drawn from the route's own
scope files at narrow scope). The unit is `KILLED` only when **every** route's canary fired;
otherwise it is `FAILED`, and its detail names the unattested routes. Each record carries
`routes: [{ route, status, target, attempts, durationMs, detail }]`. The aggregate rules below are
unchanged. A baseline-scope canary therefore costs one composite baseline run per route (cacheable,
as before); a narrow scope spanning two routes costs two narrow runs.

**A scope whose narrow baseline is not green is skipped**, not attested (`scopes[].skipped:
"narrow-baseline-not-green"`): its mutants already `ERROR` on the scope itself (`scope-non-green`,
`scope-empty`, `scope-timed-out`), and a canary injected into a broken scope could attest nothing
and could not be told apart from the breakage.

**The aggregate status**, over the canaries a run *required*:

| Outcome | `status` / `outcome` | Effect |
|---|---|---|
| Every required canary fired | `KILLED` / `passed` | Nothing refused. |
| Some fired, some did not | `PARTIAL` / `partial` | The unattested scopes' mutants are `ERROR` with `canary-not-established`; the rest run and grade. **Not** a gate failure for the exit code — the refused mutants drive it through `noVerdict` (exit 5) instead, and a `CANARY PARTIAL` banner names them at the top of the printed report. |
| None fired | `FAILED` / `failed` | The wholesale refusal, unchanged: exit 2, `results: []`. |
| None was required (every scope skipped) | `NOT-ESTABLISHED` / `not-established` | Nothing needed attesting; every mutant `ERROR`s on its own scope. Never read as a pass. |
| Skipped (`baseline --no-canary`) | `NOT-ESTABLISHED` / `"not-established"` | No canary attempted (`skipped: "no-canary"`, `scope: null`, `command: null`); never a pass; exit code unaffected. `baseline` only — the runner refuses it for any invocation with mutants, so every graded `run` establishes its own. A `CANARY SKIPPED` banner says so at the top of the printed report. |

## Refusals

The runner refuses rather than guessing. Each produces `ERROR` for that mutant — except `timed-out`,
which produces `TIMEOUT` (both are ungraded; see [the ungraded-result
shape](#the-shape-of-an-ungraded-result)) — or a usage error before the run:

| Code | Cause |
|---|---|
| `anchor-missing` | The anchor is not in the file — the catalog is stale against moved code. |
| `anchor-ambiguous` | The anchor matches more than once, so the edit is not well defined. Extend it. |
| `no-op` | `replacement` equals `anchor`, or the combined edit leaves the file unchanged. |
| `file-missing` | An anchor site's `file` does not exist. |
| `overlapping-anchors` | Two sites of one mutant overlap in the source. |
| `mixed-site-forms` | An anchor site and a patch site of one mutant touch the same file. |
| `patch-unparseable` / `patch-rejected` | git could not read the patch, or it does not apply. |
| `scope-non-green` | The narrowed scope was already failing, or exited non-zero, before any mutation — or a scope file the runner reported no test from: when the adapter reports the files it ran (`files`, e.g. `vitest`), every file the scope names must be among them (`"<file> is in scope but the runner reported no test from it (outside its include?)"`). Routed, each route's group is checked by its own adapter. |
| `scope-timed-out` | The narrowed scope was killed at its deadline **before any mutation** — `hang.blame: "suite"`, a project defect rather than a mutant to rewrite. |
| `output-truncated` | The captured output exceeded the capture limit; failure names and/or the summary banner may be missing, so no verdict can be trusted. Never `SURVIVED`. |
| `output-incomplete` | The command exited but its output streams were still open when the drain grace expired, so something else was holding them and the capture may be short. Treated exactly as `output-truncated`: never `SURVIVED`. |
| `scope-empty` | The narrowed scope ran **zero tests** — routed, any one route group ran zero. Never reported as `SURVIVED`. |
| `unexplained-exit` | Counted mode: the command exited non-zero while naming **no failing test** — something the adapter cannot see went wrong, so the run is not observably green. Never reported as `SURVIVED`. |
| `canary-not-established` | The command that would judge this mutant could not be shown to observe a deliberate break, so nothing it reports is interpretable. Two shapes: **exit-code mode**, where the per-mutant canary could not break the mutated file; and **counted mode**, where this mutant's own narrow scope was not attested by the canary gate (`gates.canary.status: "PARTIAL"`) while some other scope was. |
| `timed-out` | The command was killed at its deadline (`results[].deadlineMs`; `timeoutMs` only for a command with no unmutated reference). |
| `inplace-locked` | Trust gate, **in-place isolation only**, checked before every other gate: another code-mutant process holds this worktree — a claim in `<git-dir>/code-mutant-inplace.lock.d/` that could not be shown to belong to a dead process. Exit 2, `results: []`, nothing mutated; the detail names the holding pid, its command and the claim directory. A claim left by a dead, pid-reused or rebooted-away process is ignored and swept instead. `copy` mode never takes the lock. The lock's residual refusals are enumerated under **Isolation modes** in the README. |
| `dirty-tree` | Trust gate, `baseline`/`run` (before baseline and canary): the worktree has uncommitted or untracked-and-not-gitignored changes. `--allow-dirty` overrides it; `probe` only warns. See [The clean-tree gate](#the-clean-tree-gate). |
| `empty-diff-vs-base` | Trust gate, `run` only: `baseBranch` is configured, distinct from the branch HEAD is on, and there is no diff against it — nothing committed to mutate. See [The clean-tree gate](#the-clean-tree-gate). |
| `base-unresolvable` | Trust gate, `run` only: `baseBranch`/`--base` does not resolve to a real branch or commit. A gate failure, not a process exit — a typo'd branch name must read the same as any other trust-gate failure. |
| `base-diff-unreadable` | Trust gate, `run` only: git could not be read for the base comparison (its output exceeded the capture limit, or git itself failed). Also a gate failure rather than a process exit, so the report and its results file are still written. |
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
| `problem` | `run` could not produce a trustworthy verdict — for this mutant, or for the whole invocation when the code is run-level (the adapter, the mutation dir). Either the runner's own code refuses it — validate reports that by *calling that same code*, never by re-deciding it — or the mutant is structurally incapable of `KILLED`. | Yes → exit 4 |
| `warning` | validate's own advice. `run` proceeds; something is degraded. | **Never** |

| Code | Severity | Cause |
|---|---|---|
| every code in [Refusals](#refusals) that `resolveSites` raises (`anchor-missing`, `anchor-ambiguous`, `no-op`, `file-missing`, `overlapping-anchors`, `mixed-site-forms`, `patch-unparseable`, `patch-rejected`, `invalid-site`) | problem | Reported verbatim from `resolveSites` — the same call `run` makes. |
| `no-expect-fail` | problem | Counted grade with no `expectFail`. Such a mutant **can never read `KILLED`**: if the mutation survives it reports an un-arbitrable `SURVIVED` (nothing was claimed to fail, so the survivor block has no test to point at), and if anything catches it, `IMPRECISE`. `probe` already refuses the same shape outright. Run `run --learn` to discover the failing set and fill `expectFail` from it. |
| `no-narrow-scope` | problem | `planNarrowing` refused — references are present but none yields a scope. |
| `mutation-dir-not-ignored` | problem | Catalog-level. `.mutation/` is not gitignored, which `run` hard-stops on. |
| `adapter-no-canary` | problem | Adapter-level (routed: per route, each missing export suffixed with its route). A counted-grade adapter that does not export `canary(source, {file})` — see [Appendix B](#appendix-b--the-adapter-export-contract). Every command refuses the whole invocation on it — `baseline`, `run` and `probe` alike — before it measures anything. |
| `adapter-no-test-patterns` | warning | Adapter-level. Counted grade whose `testFilePatterns` match no tracked file (including declaring none): `mutate.mjs baseline` alone cannot discover a canary target. `run` still works when an `expectFail` reference narrows to a real test file, and `baseline` works once a run has journalled a target. Routed: reported **per route**, for a route whose `tests` match no tracked file, naming the route. |
| `route-overlap` | warning | Routed only. A tracked file matches the `tests` of more than one route; the first route in declared order runs it and the others never do. |
| `ref-file-missing` | warning | The adapter's references name files and `scopeOf(ref)` — the exact string narrowing substitutes — is not a path in this tree. |
| `ref-shape` | warning | The adapter's references do **not** name files (`dotnet`, `exit-code`) but a reference is written `file::name`. |
| `refs-ignored` | warning | Exit-code grade with `expectFail`/`expectPass` listed; at that grade the verdict is the command's exit status and those entries are never consulted. Scope with `narrowCommand` instead. |
| `narrow-downgraded` | warning | `narrowTo: "names"` will not take effect; carries the downgrade reason. |
| `report-dir-unused` | warning | Adapter-level (routed: per route). The adapter reads its results from the report dir (`vitest`, or a `custom` parser exporting `readsReportDir = true`) but `baselineCommand` or `testCommand` never mentions `CODE_MUTANT_REPORT_DIR`, so the adapter would see zero tests and the baseline gate would fail. Names the required flags. A warning, because a wrapper script can read the variable without the command naming it. |

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
  `empty-diff-vs-base` refusal. Emptiness is read from `git diff --shortstat`, whose output does not
  grow with the distance to the base, so the gate costs the same against a base one commit behind and
  one several hundred behind; the record carries that distance as `distance`. A `baseBranch`/`--base`
  that does not resolve to a real branch or commit is its own `base-unresolvable` gate failure, and
  git being unreadable is `base-diff-unreadable` -- neither is a process exit, because every gate
  failure produces the same structured record.

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
  adapter:   { name, grade: "counted"|"exit-code", modulePath,
               routes: [ { name, runner, tests, grade, modulePath } ] },   // routes: ROUTED ONLY (name "routed")
  learn:         boolean,         // true when --learn suppressed grading for this run
  mutatedSha:    string|null,     // `git rev-parse HEAD` -- points a survivor at a re-runnable commit
  reproducible:  boolean,         // false only when --allow-dirty was used to proceed on a dirty tree
  gates: {
    inPlaceLock: { outcome: "passed"|"failed", code: "inplace-locked"|null, claimDir,
                   holder: { pid, startTime, host, command, acquiredAt, tree }|null,
                   blockedBy: number, detail },
                                                         // IN-PLACE ONLY: the key is ABSENT under copy
                                                         // isolation. `holder` names the blocking claim with the
                                                         // earliest acquiredAt, and is null when no blocker could
                                                         // be read at all (a truncated or hand-edited claim);
                                                         // `blockedBy` counts every claim that blocked. Checked
                                                         // BEFORE cleanTree, so a refusal here leaves every key
                                                         // below absent
    cleanTree: { outcome: "passed"|"failed", code: "dirty-tree"|null, dirty, allowedDirty, detail },
    baseDiff:  { outcome: "passed"|"failed"|"not-established",
                 code: "empty-diff-vs-base"|"base-unresolvable"|"base-diff-unreadable"|null,
                 base, currentBranch, detail,
                 mergeBase, distance: { commitsAhead, filesChanged, insertions, deletions }|null },
                                                         // `run` only. mergeBase and distance appear only once a
                                                         // merge base resolved: a not-established or
                                                         // base-unresolvable record carries NEITHER KEY, and
                                                         // distance is null when the diff is empty or unreadable
    baseline: { outcome: "passed"|"failed", command, counts: {passed,failed,skipped,ran}|null, exitCode,
                failedTests: [string]|null, durationMs, timedOut, detail,   // failedTests: null when nothing is nameable
                fromCache, measuredDurationMs,             // (exit-code grade, or a FAILED baseline with no parsed
                                                           // failure to name); [] only when green
                groups: [ { route, runner, counts, exitCode, green, detail, durationMs } ] },
                                                           // groups: ROUTED ONLY -- each route judged on its own
    canary:   { outcome: "passed"|"failed"|"not-established"|"partial",
                status: "KILLED"|"FAILED"|"NOT-ESTABLISHED"|"PARTIAL",
                scope: "baseline"|"narrow"|"mixed"|null,   // WHICH COMMAND(S) THIS GATE ATTESTS ABOUT;
                                                      // null only when skipped
                grade, command,                       // command: baselineCommand at baseline/mixed, null at
                                                      // narrow and when skipped
                target,                               // the BASELINE half's target; null at pure narrow scope
                attempts: [ { target, durationMs, why } ],   // the baseline half's: every candidate tried and why
                scopes: [ {                                  // null when scope === "baseline"
                  command, target, status, grade, attempts, durationMs, detail,
                  mutants: [id],                             // which mutants this command judges
                  skipped: null|"narrow-baseline-not-green", // no canary was attempted for this scope
                  routes                                     // ROUTED ONLY, as below
                } ] | null,
                routes: [ { route, status, target, attempts, durationMs, detail } ],
                                                      // ROUTED ONLY: the baseline half's per-route canaries
                durationMs,                           // summed across every canary this gate ran
                detail,
                skipped: null|"no-canary",            // "no-canary": `baseline --no-canary` attempted none
                fromCache, measuredDurationMs }
  },                                                       // fromCache: true iff served from the gate cache rather
                                                           // than measured here. On a served record durationMs is 0
                                                           // and measuredDurationMs carries the original cost; on a
                                                           // measured one measuredDurationMs is null. Never absent.
  narrowBaselines: [ { command, green, counts, durationMs, groups } ],   // one entry per DISTINCT narrow scope;
                                                                        // groups ROUTED ONLY, as on the baseline
  timings: { totalMs, gatesMs, narrowBaselinesMs, mutantsMs },
  selection: { catalogTotal, selected },        // `run` ONLY -- absent on probe/baseline. How many catalog
                                                // mutants this invocation carried, out of how many the
                                                // catalog holds. The amortisation denominator: it is what
                                                // decides whether the printed FIXED COST DOMINATES note has
                                                // a remedy left to name
  resumed:   { journal, key, reused, ran } | null,   // non-null iff --resume was passed
  resumable: { key, available } | null,             // ADVISORY: a journal matches and --resume was NOT passed
  gateCache: { status: "hit"|"miss"|"bypassed",
               key: string|null, file: string|null,   // both null on a FORCED MISS -- a tree no key can describe
               measuredAt: string|null, measuredSha: string|null,   // provenance; non-null only on a hit
               canaryMeasuredAt: string|null,      // when the entry's canary was measured: equal to measuredAt
                                                   // when measured with the baseline, later when a hit filled
                                                   // the slot, null when the entry carries no canary
               lookupMs,                                            // the cache's OWN cost, not a measured command
               wrote: boolean, writeSkipped: string|null,           // why no entry was written, when none was
               canaryServed: boolean,              // a hit always serves the baseline; it serves the canary only
                                                   // when the entry carries one (never at narrow scope)
               filledCanary: boolean               // this hit filled the entry's empty canary slot
             } | null,                              // null until the key is computed -- a run that stopped at
                                                    // clean-tree, base-diff or the canary prerequisite has none
  results: [ {
    id, invariant, whyNotEquivalent, waived,
    verdict: "KILLED"|"SURVIVED"|"IMPRECISE"|"TIMEOUT"|"ERROR"|"LEARNED",
    reason,                       // machine-readable refusal/imprecision code, or null
    detail,                       // one human sentence
    grade,                        // WHICH SIGNAL GRADE PRODUCED THIS VERDICT
    reproducible,                 // same run-level value as above, copied onto every result
    narrowing: { mode: "file"|"names"|"command"|"whole", command, scopes,
                 requestedNames, downgradeReason, placeholder,
                 routes },        // routes: ROUTED ONLY -- the routes this command runs, in order
    mutation:  [ { kind: "anchor", file, edits: [{anchor, replacement, line}] }
               | { kind: "patch",  paths, patch, pathSet } ],
    expectFail, expectPass,
    failedTests, unexpectedFailures, missingFailures,
    narrowBaseline: { command, green, counts },   // the like-for-like delta reference
    mutantCounts:   { passed, failed, skipped, ran },
    delta:          { passed, failed, skipped },
    groups: [ { route, runner, counts, exitCode, durationMs } ],   // ROUTED ONLY, measured mutant runs
    canary,                       // exit-code mode only: the per-mutant gate, when one was needed
    exitCode, durationMs,
    applyMs, measureMs, restoreMs,  // this mutant's three phases; each null for a phase that never ran
    deadlineMs,                     // the wall-clock cap this mutant's command actually got
    hang: { blame: "mutation"|"suite", deadlineMs, referenceMs } | null,  // non-null ONLY on a deadline kill
    graded,                         // derived from `verdict` alone -- see below
    fromJournal                     // true iff reused by --resume rather than measured this invocation
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

**The first place to look is the printed `Cost` block**, not this table — it renders these three
buckets with each one's share of `totalMs` in the non-`--json` summary, and emits a
`FIXED COST DOMINATES` note when the **fixed** part of `gatesMs` is `>= 10 ×` the measurement it
bought *and* the catalog still holds mutants this invocation did not carry
(`selection.selected < selection.catalogTotal`). It is silent when nothing was measured, when either
measurement bucket is missing or their sum is 0, when the report carries no `selection`, and when the
fixed part of `gatesMs` is 0 (fully cached, or only narrow-scope gate work ran — nothing batching
could spread). The
threshold lives in exactly one place, `FIXED_COST_DOMINANCE_RATIO` in `lib/report.mjs`; `--json`
deliberately carries **no** derived ratio or flag, only the four raw buckets below. Rationale and the
two runs the threshold separates:
[README](README.md#where-a-runs-wall-time-went).

| Field | Covers |
|---|---|
| `timings.totalMs` | The whole invocation, including a run that stopped at a failed gate. |
| `timings.gatesMs` | `gates.baseline.durationMs + gates.canary.durationMs`. Mostly fixed cost — paid once per invocation regardless of mutant count — but **not entirely**: a canary at `scope: "narrow"` is one run per *distinct* scope, so that part scales with the mutants in the run (the printed `Cost` block names the fixed part when they differ). **0 when no gate command ran here**, which in practice means both were served from cache — the original cost is then at `gates.*.measuredDurationMs` — though a record can carry `durationMs: 0` without any cache involvement (the canary-prerequisite refusal runs nothing). The cache's own lookup cost is `gateCache.lookupMs`, deliberately outside this sum. |
| `timings.narrowBaselinesMs` | Sum of `narrowBaselines[].durationMs` — one measured command per *distinct* scope, so N mutants at one scope cost one entry. |
| `timings.mutantsMs` | Sum of `results[].durationMs`. A **sum of per-mutant wall clocks**, so under `jobs > 1` it legitimately exceeds `totalMs`. |
| `results[].applyMs` / `measureMs` / `restoreMs` | The harness's own snapshot+apply and restore cost, versus the project's command. Disjoint slices of that result's `durationMs`; `null` for a phase that never ran (an `ERROR` that stopped before Phase B). The remainder, when there is one, is the per-mutant exit-code canary — its own cost is on `results[].canary.durationMs`. |
| `gates.canary.attempts[].durationMs` | **Scope-dependent.** At `scope: "baseline"` (and for the baseline half of `"mixed"`): one entry per candidate that did not establish the gate; an entry whose command **ran** is a whole `baselineCommand` run, and one the adapter **declined** (its `canary()` returned `null` for that file) ran nothing and carries `durationMs: 0`. Up to 5 candidates are *measured* — declines are not charged to that budget, though the walk still stops after 50 of them — so a project whose early candidates sit outside its `baselineCommand`'s scope pays up to 5× before the gate establishes anything. At `scope: "narrow"` the candidates are exactly the files that scope's own command names, so each attempt costs **one narrow run** and the walk is bounded by that scope's file count — in practice one. |
| `gates.canary.scopes[].durationMs` | One narrow-scope canary. `gates.canary.durationMs` is their sum plus the baseline half's, so the aggregate cannot drift from its parts. A `skipped` scope ran no command and carries `0`. |

## Deadlines and hang blame

`timeoutMs` is the **ceiling**. A measured command that has a **like-for-like unmutated reference**
gets a tighter deadline derived from it instead; only a command with no reference falls back to the
ceiling. `results[].deadlineMs` is what the command actually got.

| Command | Reference | Deadline |
|---|---|---|
| global baseline | none | `timeoutMs` |
| narrow baseline | none | `timeoutMs` |
| canary attempt (`scope: 'baseline'`) | the global baseline's `durationMs` — same command | derived |
| canary attempt (`scope: 'narrow'`) | that scope's narrow-baseline `durationMs` — same command | derived |
| mutant run | that scope's narrow-baseline `durationMs` — same command | derived |
| per-mutant canary (`scope: 'mutant'`) | that scope's narrow-baseline `durationMs` | derived |
| `setup` / `teardown` hooks | none | `timeoutMs` |

The derivation itself and the `hang` config key live in the README's config table and in
`mutate.mjs --help`, the two homes every config key has in this project; not restated here.

`hang` is non-null **only** when a command was killed at its deadline. It annotates *which side* the
kill is attributable to; the **verdict and `reason` stay the thing you act on**. These are the only
reachable combinations:

| Verdict | `reason` | `hang.blame` | Reading, and what to do |
|---|---|---|---|
| `TIMEOUT` | `timed-out` | `mutation` | The **mutant run** was killed. Reaching it required the *same command* to have been measured unmutated and green, so the only thing that changed is the mutation — rewrite it smaller. |
| `ERROR` | `scope-timed-out` | `suite` | The **narrow baseline** was killed, before any mutation was applied. A project defect: report it upward, and do **not** rewrite or drop the mutant — that cannot fix it. `referenceMs` is `null`, because a narrow baseline has no reference of its own. |
| `ERROR` | `setup-hook-failed` / `teardown-hook-failed` | `mutation` | A hook failed on a run that had also timed out — the setup hook itself, or the mutant command ahead of a failing teardown. The **hook** is what to fix; `hang` is incidental here, and `deadlineMs` names the mutant's derived deadline even though a hook runs at `timeoutMs`. |

Two consequences worth stating outright, because both have been written down wrongly before:

- **`blame: "suite"` never appears on `TIMEOUT`.** A mutation that was never measured cannot be
  blamed, so a hung *unmutated* scope is `ERROR`/`scope-timed-out`. Guidance for `suite` filed under
  `TIMEOUT` is guidance on an unreachable combination.
- **`TIMEOUT` always carries `blame: "mutation"`, but the converse does not hold** — row three is a
  `blame: "mutation"` that is not a `TIMEOUT`. Key routing on the verdict and `reason`, not on
  `blame` alone.

`gates.baseline.timedOut` is the same signal one level up, for a hang at the gate.

## The shape of an ungraded result

`ERROR` and `TIMEOUT` mean **no verdict was reached**. The 2026-0183 failure was a consumer
collapsing those into survivors, and it was possible because both carried `failedTests: []` — the
one field it looked at. So the contract is:

> **No field on an ungraded result carries the value it would carry on a `SURVIVED` result.**

| Field | Graded (`KILLED`/`SURVIVED`/`IMPRECISE`/`LEARNED`) | Ungraded (`ERROR`/`TIMEOUT`) |
|---|---|---|
| `graded` | `true` | `false` |
| `reason` | `null`, or one of the four `IMPRECISE` codes (`compile-error`, `expect-pass-broke`, `extra-failures`, `partial-kill`) | always a non-null refusal code — see [Refusals](#refusals) |
| `failedTests` | `[]` when nothing failed — a **measurement** | `null` — nothing is *nameable* |
| `unexpectedFailures` / `missingFailures` | `[]` | `null` |

Three independent fields, so a consumer keyed on any one of them reads correctly. `graded` is
**derived from the verdict alone** and cannot contradict it. In the printed matrix an ungraded row's
`actual` column reads `not graded`, never `(none)`.

`summary.errored + summary.timedOut === summary.noVerdict`, which is why there is no fourth
synonym field.

The run report has **no `problem` field** — that belongs to
[`validate`](#the-validate-report), which emits a deliberately different shape. A consumer looking
for `problem` on a run result is reading the wrong report.

## Resuming a run

`run` appends each completed verdict to **`.mutation/journal/<key>.jsonl`** (JSON Lines, one line per
mutant, flushed as it goes — so a process that never gets to run its exit path still leaves every
verdict before the one in flight). Gitignored, guarded by the same assertion as
`.mutation/results/`. `run --resume` reuses matching verdicts instead of re-measuring them.

**Written only when** `reproducible === true` and `mutatedSha !== null` — a `--allow-dirty` run
journals nothing, because a non-reproducible verdict must never become a resumable one.
`--resume --allow-dirty` is a usage error (exit 4). Only Phase-B results are journalled; a plan
failure (stale anchor, unparseable patch) cost no measured command and is free to recompute.
Ungraded Phase-B results are journalled too, such as a `TIMEOUT` or an `ERROR` like
`scope-timed-out`, so resume reuses them on an unchanged mutant. `run --id <id>` without `--resume`
re-measures one, and its new journal line supersedes the old. The canary gate's
`canary-not-established` refusal is never journalled: it belongs to that invocation's gate (an
exit-code mutant's own canary `ERROR` is an ordinary result, and is). A line is appended only once
the mutant's run returned, so a journalled result that applied a mutation always implies its tree
was restored and proved; one that stopped before applying (a `scope-*` `ERROR`, say) carries no such
proof.

**`<key>` covers** `mutatedSha`, the adapter (`name`/`grade`/`modulePath`), `isolation`, `jobs`,
`learn`, and a config fingerprint over `baselineCommand`, `testCommand`, `runner`, `timeoutMs`,
`hang`, `setup`, `teardown`, `preserve`. Change any of them and the key changes, so nothing is
reused. `jobs` is in there deliberately: reusing a `jobs=4` verdict inside a `jobs=1` re-run would
hide precisely the concurrent-suite hazard the README tells you to check for. `hang` is in there so
retuning the deadline forces every hung mutant to be re-measured.

**Per mutant**, reuse additionally requires an unchanged fingerprint over `id`, `sites`,
`expectFail`, `expectPass`, `narrowTo` and `narrowCommand` — everything that changes *what is
measured*. `invariant`, `whyNotEquivalent` and `waived` are deliberately **excluded**: they are prose
and decisions, re-read from the current catalog on reuse. So recording a waiver costs no re-run.

**The two things resume never does:**

- **It never reuses a gate.** Resume reuses a *verdict* — a graded claim about a mutant — and a
  verdict's trustworthiness rests on gates that held for *this* tree, so its gates are established
  every invocation regardless of what is journalled. (The journalled canary *target* is reused as a
  candidate **hint**, reordering which files the gate tries first; the gate still runs and must still
  fire.) A gate may still be **served from the gate cache**, which is a separate decision on a
  separate key — see [Caching the gates](#caching-the-gates). The reason behind the older, stronger
  claim is unchanged and still governs: a gate that did not run this invocation must never read as
  one that passed, the exact ambiguity `not-established` exists to prevent. A cache hit is not that —
  it is a measurement keyed on the tree it was made against, served verbatim and labelled
  `fromCache`, so `not-established` stays `not-established` and nothing is promoted to `passed`.
- **It never assumes tree state.** The journal records verdicts, never "what I left in the tree". A
  SIGKILL can leave a mutation behind, and on the next invocation the clean-tree gate sees it as an
  uncommitted change and refuses (exit 2) rather than resuming onto a poisoned tree. The gate cache
  makes the same refusal for itself without depending on that gate: its key is over worktree **bytes**,
  so a tree carrying residue hashes differently from the tree an entry was measured against.

Reuse is **opt-in** because a reused verdict was produced by a process nobody watched. Every one is
labelled `fromJournal: true`, counted in `resumed.reused`, and named in the printed report, so it
never reads as a verdict this run made. When a journal matches and `--resume` was *not* passed, the
report carries `resumable` and the CLI prints an advisory naming the flag — **advisory only**: never
a refusal, never a gate, no effect on the exit code.

## Caching the gates

The **baseline** gate is a **fixed cost paid once per invocation**, independent of mutant count.
Measured on code-conductor (`npm test` ≈ 67 s, 35-mutant catalog) **before the canary was narrowed**,
when the floor was two full `baselineCommand` runs and the whole gate cost was therefore fixed:
~135,000 ms, **98.6% of a single-mutant invocation**. The floor is now one full run plus one narrow
run per resolved scope ([The canary's scope](#the-canarys-scope)), and only the full run is fixed —
a narrow canary scales with the mutants in the run, which is why
[`timings.gatesMs`](#where-a-runs-wall-time-went) is not all fixed cost. The baseline half does not depend on which mutants are in the run, so
it is persisted and reused against a tree that has not changed.

**NARROW-SCOPE CANARIES ARE NEVER CACHED, BY DESIGN — on the serve side as well as the write side.**

- *Write:* `gates.canary` is written to the entry only when the canary ran at `scope: "baseline"`;
  otherwise — narrow or mixed scope, or skipped by `baseline --no-canary` — the entry records
  `canary: null` — present, so a reader can tell it from an entry written before the field existed,
  and legal, so it is served as "the baseline is yours, measure the canary here".
- *Fill:* a **hit** on an entry whose `canary` is `null` writes the canary this invocation measured
  into that entry — once — when `canaryToFill` (`lib/runner.mjs`) accepts it: the stored slot is
  `null` (a stored canary is **never overwritten**), and the canary is present, `fromCache: false`,
  not skipped, `scope: "baseline"` and `status: "KILLED"`. A narrow, mixed, failed,
  `not-established` or partial canary is never filled. The fill obeys the same four write conditions
  below, writes to the same Phase-A key the entry was read under, carries `keyInputs`, `measuredAt`,
  `measuredSha` and the baseline record over verbatim, stamps `canaryMeasuredAt`, and sets
  `gateCache.wrote` and `gateCache.filledCanary`. So a whole-suite canary is paid at most once per
  key, including after `baseline --no-canary`.
- *Serve:* a cached canary is served **only when no pending mutant needs narrow attestation**
  (`needsNarrowCanary`, the same predicate the gate partitions on). `mutate.mjs baseline` files a
  perfectly legitimate baseline-scope canary against a tree; serving it to a later `run` on that same
  tree would put the record's claim and the run's verdicts on two different commands — a `SURVIVED`
  published beside a canary reading `passed` for a command no verdict came from. The baseline half is
  still served in that case; only the canary half re-measures.

This is what keeps the key's own rationale for excluding the catalog (below) true **verbatim**: a
narrow canary is derived from the catalog, and two different catalogs against one tree hash to the
same key.

A hit is **not** "a gate that did not run". It is a measurement keyed on the tree it was made
against; its outcome is served **verbatim** (`not-established` stays `not-established`, nothing is
promoted to `passed`) and labelled `fromCache: true` on the record, in `--json` and on the printed
gate line. `gateCache.canaryServed` says whether the canary half was served, and the top-of-report
banner has two forms because of it:

- **both served** — `GATES FROM CACHE -- baseline and canary were measured <ts> …`, or, when a hit
  filled the canary slot after the baseline was measured (`canaryMeasuredAt` differs from
  `measuredAt`), `GATES FROM CACHE -- the baseline was measured <ts> and the canary <ts> …`;
- **baseline only** — `BASELINE FROM CACHE -- … The canary was measured HERE: a narrow-scope canary
  is never cached, and an entry from `baseline --no-canary` carries none.`, or, when this invocation
  skipped the canary, `… No canary was measured here (--no-canary).`

A resumed run's `RESUMED` banner names the same three states, so the two banners can never
contradict each other.

**Location:** `.mutation/gates/<key>.json`, beside `.mutation/journal/` and `.mutation/results/` and
with the same lifetime — one review loop, gitignored, dies with the worktree. Written atomically
(temp file + rename in the same directory), so a SIGKILL mid-write leaves no half-entry. One entry
per distinct tree+config; no pruning.

**`<key>` is `sha256` over six inputs, truncated to 32 hex** (the same shape as the journal key):

| Input | Derivation | Why it is in the key |
|---|---|---|
| `treeDigest` | `git rev-parse HEAD^{tree}`, plus a canonical `(path, state)` list for every path `git status --porcelain -z -uall` reports; `state` is `<mode>:sha256(bytes)`, `absent`, or `link:<target>` | The gates measure the project's code. Committed content rides the tree sha; anything modified, staged, deleted or untracked-not-ignored is content-hashed. This is what makes a hit mean *byte-identical tree*, not *same commit*. The mode is in the state because `chmod +x` with identical bytes is reported by porcelain and changes what an exec-bit-dependent suite does. |
| `configFingerprint` | The same fingerprint `journalKey` uses (`lib/fingerprint.mjs`) — over `baselineCommand`, `testCommand`, `runner`, `timeoutMs`, `hang`, `setup`, `teardown`, `preserve` | The resolved commands are what was measured. `timeoutMs` bounds the baseline, `hang` derives the canary's deadline, `setup`/`teardown` wrap every measured command, `preserve` changes what a copy contains. `testCommand` is not run by either gate and is in the key anyway: the fingerprint is the harness's identity, not a subset a later edit can drift from. |
| `adapter` | `{name, grade, modulePath}` | The adapter decides whether the baseline is green and which canary path runs. A `custom` adapter's `parse.mjs` is tracked beside `config.json`, so `treeDigest` covers its contents too. |
| `isolation` | `"in-place"` \| `"copy"`, after any `--copy`/`--in-place` override | A copy is not a git repository, so a suite that shells out to git is green in-place and red in a copy. Two different measurements. |
| `harnessFingerprint` | `sha256` over the sorted `(relPath, sha256(bytes))` of `mutate.mjs` and every `lib/**/*.mjs` | The harness version, self-maintaining. `package.json` carries no `version` and this is a private plugin merged with no release step, so a version string only invalidates when someone remembers to bump it. A source digest cannot drift from the code it identifies. |
| `runtime` | `{version, platform, arch}` from `process` | A node upgrade changes what a suite does without changing a byte of the tree, and a bind-mounted worktree can be entered from two platforms. |

**The forced miss.** Some trees cannot be described by any key, and the answer is always a miss that
also **writes nothing** — `gateCache.status: "miss"` with `key` and `file` both `null` and the reason
in `writeSkipped`. Filing an entry under a key that cannot tell its own tree apart is the false hit,
not a cure for one. Three causes:

- **An unborn HEAD.** No committed state to key on. A miss, never a refusal: the gates ran on a
  zero-commit repo before this cache existed and still do.
- **A path git names that cannot be reduced to bytes** — an untracked **embedded git repository**
  (which `-uall` collapses to a single `?? vendor/inner/` entry; a plain untracked directory *is*
  expanded to its files and stays digestable), a **submodule with dirty contents** (always the one
  line ` M sub` however much of its worktree moved), or an unreadable path. Each varies freely under a
  porcelain line that does not move, so any shared placeholder state would collide two different trees
  into one key.
- Costs nothing in practice: every one of those shapes is a tree `run` and `baseline` already refuse
  as dirty. What stays cacheable is the clean tree, which is the case this feature exists for.

**Deliberately not in the key:**

- **`jobs`** — the deliberate contrast with `journalKey`, which *does* include it. The gates run
  serially in the primary workspace during Phase A, before any concurrency exists, so a gate measured
  serially is the same measurement at any `jobs`. Reusing a `jobs=4` *verdict* under `jobs=1` would
  hide the concurrent-suite hazard; reusing a gate *measurement* cannot.
- **`learn`** — it suppresses grading and changes neither gate command.
- **`mutatedSha`** — implied by `treeDigest` and weaker than it; an amend or rebase that changes no
  bytes changes no gate. It is recorded on the entry as `measuredSha` and surfaced on a hit, so a
  reader can see a measurement that came from a different commit with identical content.
- **`.mutation/` itself, the catalog included** — gitignored, so `git status` never reports it. Required
  for correctness (the cache writing its own entry must not invalidate its own key), and right on the
  merits: the baseline-scope canary proves that *`baselineCommand` observes a deliberate break in a
  file it exercises*, a property of the command and not of the mutants. That rationale holds for
  exactly the records that are cached, and only because a narrow-scope canary — which *is* a property
  of the catalog — is never one of them. **Consequence:** rewriting an `IMPRECISE` mutant and
  re-running costs no gates (the baseline half; its canary is re-measured either way).
- **Gitignored state the suite reads** — `node_modules/`, a `.env`, a local database, a build cache;
  environment variables likewise. Not git-visible and not cheaply hashable. **This is the one real
  exposure**, and `--remeasure-gates` is the correction path. It is bounded in practice by the entry
  living in `.mutation/`, which dies with the worktree. A wall-clock TTL was rejected: an
  `npm install` takes seconds, so any TTL long enough to be useful is far too long to prevent one.

**An entry is written only when all four hold**, and only from a run that reached the end:

1. `noTrace.ok === true` — the run proved it left nothing behind;
2. `reproducible === true` — mirrors the journal's rule; a `--allow-dirty` run records nothing reusable;
3. neither gate `FAILED` (implied — every gate failure returns before `noTrace` is computed);
4. `.mutation/` is gitignored. When it is not, the write is **skipped** and the reason recorded at
   `gateCache.writeSkipped` — `baseline` deliberately has no hard stop on an unignored `.mutation/`
   and does not acquire one here.

**The key is computed once, in Phase A, and the write uses that key** — never one recomputed at the
end. A key derived after Phase B would hash a tree that was mutated and restored, so a restore that
silently failed would file a clean-tree measurement under a residue-tree key. That is the one way
this feature could manufacture a false hit, and the ordering removes it by construction. Two further
consequences of writing only at the end: a run killed mid-mutation writes **nothing** (it re-pays the
gates next time — the correct trade), and a tree carrying crash residue can never be served a clean
gate, because the digest is over worktree bytes.

The entry's `schemaVersion` is **3**: it identifies the entry SHAPE, which gained a nullable
`gates.canary` and then `canaryMeasuredAt`, where `harnessFingerprint` identifies the harness. Conflating the two is how one of
them silently stops being maintained.

A malformed **or unreadable** entry — bad JSON, an `EACCES` on the file, wrong `schemaVersion`, a
`key` that disagrees with its filename, the baseline record missing, the `canary` **key** absent
(as against present-and-null, which is legal), or the `canaryMeasuredAt` key absent — is a
**logged miss** on stderr,
not a throw: the gates are re-measured and the entry overwritten. A crafted entry can therefore never
deny a run. `keyInputs` is recorded inside the entry so an operator can diff two entries and
see why one missed; it is never read back as an authority, because the filename is the key.

**`--remeasure-gates`** (`baseline`, `run`, `probe`; a usage error elsewhere) skips the lookup,
measures both gates, and **writes the fresh result over the entry for this key**. The write half is
what makes it the in-band correction path for an entry that key-matches but was measured under
changed un-keyed state. `baseline --remeasure-gates --no-canary` overwrites the entry with
`canary: null`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No un-waived survivors, every mutant produced a verdict, gates passed. |
| 1 | At least one **un-waived survivor** — a coverage claim is false. |
| 2 | A trust gate failed (clean-tree, empty-diff-vs-base, baseline, or canary); no verdict is interpretable. |
| 3 | Restore or the clean-tree assertion failed — inspect the tree by hand. |
| 4 | Usage, config, or catalog error. |
| 5 | No survivors, but some mutant produced **no verdict** (`ERROR`/`TIMEOUT`) — not a clean proof. |
| 6 | No `harness/mutation/config.json`: this project is not configured for mutation testing. Nothing ran and nothing is claimed. **Not an error** — the notice goes to stdout, `stderr` stays empty, and `--json` gets the same plain text (there is no report object to shape). |

Code 5 exists so a catalog whose mutants all fail to resolve cannot read as "0 survivors, clean".

Code 6 is deliberately non-zero rather than 0: exit 0 means "gates passed, no survivors", so a
project with no harness must not land there. It is also not 4 — an absent harness is a supported
configuration, not a config error.

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
  issues:  [ { severity: "problem"|"warning", code, detail } ],   // run-level: the adapter, the mutation dir
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

# Appendix B — the adapter export contract

`runner: "custom"` loads `parse.mjs` from **beside `config.json`** (i.e. `harness/mutation/parse.mjs`)
and calls:

```js
export function parse(stdout, stderr, exitCode, context) { … }
```

`context` is optional to use and is `{ cwd, reports }`:

- `cwd` — the absolute root of the workspace the command ran in (the copy, under `copy` isolation).
  A runner that reports absolute paths relativises against it, as the shipped `vitest` adapter does.
- `reports` — `{ <basename>: <text> }`, every regular file the command wrote directly into its
  **report dir**. Every measured command (baseline, narrow baseline, canary, mutant) gets a fresh,
  empty directory under the OS temp dir, outside the workspace, exported to it as
  `$CODE_MUTANT_REPORT_DIR` and removed after `parse` (on the timeout and signal paths too). A runner
  that writes a machine report to a file is pointed there through the shell, e.g.
  `--outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"`. Report bytes count toward the same capture
  cap as stdout and stderr: over it, the run is truncated — `ERROR` (`output-truncated`), never a
  verdict — and `reports` is `{}`. `/dev/stdout` is not an alternative: the runner captures through
  a Unix socket on Linux, which a path-based `open()` cannot write to (`ENXIO`).

`groups` is never a field a parser returns: it is produced only by the routed adapter
(`lib/routing.mjs`), which hands each route's output to that route's own adapter — a `custom` route
included — with the workspace's `cwd` and that route's own `reports`.

An adapter that reads its results from the report dir may declare `export const readsReportDir =
true` (and `export const REQUIRED_FLAGS = "<flags>"`), so `validate` warns (`report-dir-unused`) when
a command never mentions `$CODE_MUTANT_REPORT_DIR`.

It must return:

| Field | Type | Meaning |
|---|---|---|
| `grade` | `"counted"` \| `"exit-code"` | The grade of **this verdict**. Defaults to `"counted"`. It does **not** set the adapter's grade and does **not** confer the exit-code canary exemption — only the module-level `export const grade` below does that. |
| `passed` / `failed` / `skipped` | number | Counts from this run. Reporting zero failures while the command exited non-zero makes the mutant `ERROR` (`unexplained-exit`), never `SURVIVED` — the counters alone are not taken as green. |
| `ran` | number | Tests the command actually reported, **including skipped**. `0` makes the mutant `ERROR` (`scope-empty`), never `SURVIVED`. |
| `failedTests` | `[{ file, name, id }]` | `id` is what `expectFail`/`expectPass` are compared against. |
| `compileError` | boolean | True for a build/module-load break. Yields `IMPRECISE`. Never guess it from an exit code alone. |
| `counts` | object | Free-form extras, carried into the report. |
| `files` | `[string]`, optional | The repo-relative test files the run reported. When present, every file a narrowed scope names must appear in it, or that scope's narrow baseline is non-green (`"<file> is in scope but the runner reported no test from it (outside its include?)"`) and its mutants are `ERROR` (`scope-non-green`). Absent, no such check is made. |
| `diagnostic` | string \| null, optional | Why the parser read nothing, when it read nothing (e.g. no report on stdout). Appended to the zero-tests detail of a baseline, a narrow baseline and a `scope-empty` result. |

**The adapter's grade is a module-level export**, separate from the `grade` field `parse()` returns:

```js
export const grade = 'counted'; // or 'exit-code'; default 'counted'
```

This export — and nothing else — selects the canary path; the `grade` field `parse()` returns is
per-verdict and does not. Within a `custom` parser, `export const grade = "exit-code"` is the only way
to declare a gate with no named tests (`runner: "exit-code"` is the other way, and is the right one
unless you also need a custom `scopeOf`/`substitute`). Its canary is then synthesised by injecting an
unparseable line into the mutant's own site file, so it needs neither `canary` nor `testFilePatterns`.

**`canary(source, {file})` is REQUIRED at counted grade.** Without it no canary can be synthesised
for any target file, so the gate can never be established in any repo state. Every command — `baseline`,
`run`, `probe` — refuses such a harness pre-flight, before the baseline command and, in copy mode,
before any tree copy, with a `FAILED` canary gate and exit `2`; `validate` reports it as the
`adapter-no-canary` problem. It must return `{ content, testId, matches(failure) }`, or `null` to
decline **that file**, which is legal: the next candidate is tried, each decline recorded as an
attempt carrying `durationMs: 0` (a decline runs no command, so it is not charged to the budget of 5
measured candidates; the walk stops after 50 declines), and the gate fails only when no candidate
establishes it. When either cap cuts the walk short, the gate's `detail` says so.

Other optional exports, each with a safe default if omitted: `scopeOf(ref)` (default: the file part),
`substitute({scopes, refs, mode})` (default: space-joined quoted paths), `canNameFilter` (default
`false`), `refsNameFiles` (whether a test reference names a file in the repo; used only by
`validate`'s reference check — default: true when you did **not** override `scopeOf`, since you then
inherit the file-part derivation, false when you did), and `testFilePatterns` (default `[]`).

`testFilePatterns` is how `mutate.mjs baseline` — with no mutants in play, so no scope to borrow —
discovers a canary target on its own; without it that command's canary gate fails. It is **not** a
prerequisite: under `run` the canary borrows the mutants' own narrow scopes, and a later `baseline`
borrows the canary target the previous run journalled. Declaring it is what makes `baseline`
self-sufficient, and `validate` warns (`adapter-no-test-patterns`) when it is absent.

A project parser owns **output parsing and nothing else** — never isolation, restore, or verdict
semantics. Those must mean the same thing in every project, or the trust gates degrade into
per-project code that validates itself.
