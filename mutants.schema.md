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
| `scope-non-green` | The narrowed scope was already failing before any mutation. |
| `scope-empty` | The narrowed scope ran **zero tests**. Never reported as `SURVIVED`. |
| `canary-not-established` | Exit-code mode: the gate could not be shown to observe a deliberate break in the mutated file, so its "survivor" means nothing. |
| `timed-out` | The command exceeded `timeoutMs`. |
| — | Writing under `.mutation/` when it is not gitignored is a **hard stop** (exit 4), not a warning: this run would otherwise leave visible untracked files in a worktree it does not own and cannot commit a fix to. |

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
  gates: {
    baseline: { outcome: "passed"|"failed", command, counts: {passed,failed,skipped,ran}|null, exitCode, detail },
    canary:   { outcome, status: "KILLED"|"FAILED"|"NOT-ESTABLISHED", grade, target, detail }
  },
  results: [ {
    id, invariant, whyNotEquivalent, waived,
    verdict: "KILLED"|"SURVIVED"|"IMPRECISE"|"TIMEOUT"|"ERROR",
    reason,                       // machine-readable refusal/imprecision code, or null
    detail,                       // one human sentence
    grade,                        // WHICH SIGNAL GRADE PRODUCED THIS VERDICT
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
    exitCode, durationMs
  } ],
  noTrace: { ok, before, after } | null,
  pathSetMismatches: [ … ],
  summary: { total, open, waived, survivors, waivedSurvivors, noVerdict, killed, imprecise },
  exitCode: number
}
```

`narrowBaseline.counts` is the **same scope measured unmutated**, memoised per resolved command
string. It exists so `delta` compares like with like: the global baseline runs the whole suite while
a mutant runs a narrowed scope, so comparing those two would show the narrowing, not the mutation.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No un-waived survivors, every mutant produced a verdict, gates passed. |
| 1 | At least one **un-waived survivor** — a coverage claim is false. |
| 2 | Baseline or canary gate failed; no verdict is interpretable. |
| 3 | Restore or the clean-tree assertion failed — inspect the tree by hand. |
| 4 | Usage, config, or catalog error. |
| 5 | No survivors, but some mutant produced **no verdict** (`ERROR`/`TIMEOUT`) — not a clean proof. |

Code 5 exists so a catalog whose mutants all fail to resolve cannot read as "0 survivors, clean".

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
| `passed` / `failed` / `skipped` | number | Counts from this run. |
| `ran` | number | Tests the command actually reported, **including skipped**. `0` makes the mutant `ERROR` (`scope-empty`), never `SURVIVED`. |
| `failedTests` | `[{ file, name, id }]` | `id` is what `expectFail`/`expectPass` are compared against. |
| `compileError` | boolean | True for a build/module-load break. Yields `IMPRECISE`. Never guess it from an exit code alone. |
| `counts` | object | Free-form extras, carried into the report. |

Optional exports, each with a safe default if omitted: `scopeOf(ref)` (default: the file part),
`substitute({scopes, refs, mode})` (default: space-joined quoted paths), `canNameFilter` (default
`false`), `testFilePatterns` (default `[]`), `canary(source, {file})` (default: none, which makes the
canary gate fail loudly rather than pass silently).

A project parser owns **output parsing and nothing else** — never isolation, restore, or verdict
semantics. Those must mean the same thing in every project, or the trust gates degrade into
per-project code that validates itself.
