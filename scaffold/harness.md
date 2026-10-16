# Scaffold a mutation-verification harness

Build a project-local mutation-testing harness at `harness/mutation/`, driven by the shared
`code-mutant` runner — so a prover can later run `/code-mutant:prove` against this project. This is
a one-time bootstrap.

Invoke the runner as `node "$CC_PROJECTS_ROOT/.plugins/code-mutant/mutate.mjs" <command>`, with
this project as the working directory. If `CC_PROJECTS_ROOT` is unset, stop and report it; never
search for the runner.

## What to build

1. `harness/mutation/config.json` — required: `baselineCommand`, `testCommand` (with a `{tests}`
   placeholder), `runner`. Optional, each with a default the runner applies if you omit it:
   `isolation`, `preserve`, `timeoutMs`, `hang`, `jobs`, `baseBranch`, `setup`/`teardown` (`--help` lists
   the defaults). Base every value on this project's *real* commands (its actual `package.json`
   scripts, CI config, or whatever the test suite is actually invoked with) — don't guess or reuse
   another project's values.
2. **Pick `isolation`** from this project's real gates — and only fall back to a default when
   they're genuinely ambiguous:
   - `"in-place"` — a mutant's command boots a server, needs a build cache, or depends on absolute
     paths (e.g. a Playwright/browser gate, Next.js, anything with real filesystem state), or shells
     out to git inside the tree (a copy has no `.git`). Also the fallback when the project's gates
     don't clearly call for either mode.
   - `"copy"` — pure in-process unit tests, or when `--jobs` parallelism is wanted; it is the only
     mode where `jobs > 1` does anything (in-place clamps it to 1).
3. **Pick `runner`** by actually running the project's test command once and capturing its real
   stdout/stderr. If the command emits no pass/fail/skip counts at all — a gate like
   `npx tsc --noEmit` or `npm run snap` — pick `runner: "exit-code"`, never a `custom` parser for
   output that has nothing to parse; its verdicts are the degraded signal grade (kill/no-kill
   only), and a per-mutant `narrowCommand` is how an exit-code gate gets narrowed. Otherwise match
   the captured output against a shipped adapter:
   - `node-test` — proven end-to-end; use it as-is.
   - `vitest` — proven end-to-end, and it reads **only** Vitest's JSON report file: both commands
     must pass `--reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"` (the runner sets
     that variable per command) and run from the repo root, selecting a nested config with
     `--config <path>` — never `cd`, since test references and `{tests}` are repo-relative.
   - `pytest`, `dotnet` — the parser is pinned to captured fixtures but has never driven
     a full mutate cycle, so check it against the output you just captured rather than assuming it
     fits, and write a `custom` parser instead if it disagrees.
   - Nothing matches — write the `custom` parser. That is the intended path, not a last resort:
     `harness/mutation/parse.mjs` (that exact filename, beside `config.json`) exporting
     `parse(stdout, stderr, exitCode, context)` — **plus `canary(source, {file})`, which is required**:
     without it no canary can be synthesised for any file, and `baseline`, `run` and `probe` all
     refuse the harness pre-flight at exit 2, before measuring anything (`validate` reports it as a
     problem instead, exit 4). Declare
     `testFilePatterns` too, or `mutate.mjs baseline` on its own cannot discover a canary target
     (`run` borrows the mutants' own scopes instead). Full export contract: `code-mutant`'s
     `mutants.schema.md` Appendix B. Prove it against the captured output before finishing.

   A counted-grade command must exit 0 whenever no test failed: one that chains a lint or guardrail
   step exiting non-zero on its own fails the baseline gate (`outcome: "failed"`), so scope
   `baselineCommand`/`testCommand` to the test run itself.
4. **Set `baseBranch`** to the branch this project actually merges into (`main`, `master`, or
   whatever its real integration branch is). Left unset, `run`'s empty-diff-vs-base gate reports
   `not-established` and checks nothing, so a review of a branch with no committed work would read
   as a clean sweep, and `candidates` has no base to fall back on.
5. **Scope `baselineCommand` across the project's test files, not one subdirectory.** Under `run`,
   the canary gate is established against each command that *judges* a mutant — the narrowed
   `testCommand`, which names its own scope files — so `baselineCommand`'s scope does not come into
   it for a catalog whose mutants all narrow. It does for everything else: `baseline`, an empty
   catalog, and any mutant the gate cannot narrow. That last set is six conditions, enumerated in
   full under "The canary's scope" in `code-mutant`'s `mutants.schema.md` — `narrowTo: "names"`, a
   per-mutant `narrowCommand`, `exit-code` grade, **an adapter whose refs do not name files (every
   `dotnet` project, and any `custom` parser exporting its own `scopeOf`)**, a `testCommand` with no
   `{tests}`, a narrow command that resolves to `baselineCommand` (including `--learn`'s no-refs
   fallback), and a ref naming a file the tree does not have. There the gate injects a
   guaranteed-failing test into a candidate file, in this order: the target a previous run
   journalled, then the scopes this run's own mutants narrow to, then tracked files matching the
   adapter's `testFilePatterns` in sorted order. If the first few candidates sit outside
   `baselineCommand`'s scope it burns a baseline run per attempt and then fails the gate, so a repo
   whose alphabetically-first test files live outside the suite you'd normally run is the case to
   watch. A bare `baseline` has no mutants to borrow scopes from, so on a repo with no journal yet it
   has only the patterns to go on — which is why a `baseline` can fail the canary gate on a harness
   whose `run` establishes it, and why the same `baseline` passes afterwards once a run has
   journalled a baseline-scope target.
6. Write `harness/mutation/README.md` documenting how to invoke the harness for *this* project.
   Command syntax and flags are `mutate.mjs`'s own CLI, so read it directly (`--help` or its
   source) rather than copying examples from another project's harness, which can drift. Write
   every invocation in that `$CC_PROJECTS_ROOT` form — never a relative path to the runner, and
   never this machine's expanded path — and state that a shell outside code-conductor must export
   `CC_PROJECTS_ROOT` (the absolute projects root) first. Call nothing in it verified unless you
   ran it in this project — name the command and what it produced, or don't make the claim.
7. Add `.mutation/` to this project's `.gitignore` (per the workspace git-hygiene convention —
   verify the pattern actually matches via `git status` before the first commit that touches it).
8. **Verify by running it before you finish.** `mutate.mjs baseline` (without `--no-canary`), invoked as above, must report the
   baseline `passed` **and** the canary `KILLED`; the one exception is an `exit-code`-grade harness,
   which has no named test to inject and reports `not-established`. Files existing is not "done" —
   fix `config.json` (or the parser) until the gates read that way, and record the numbers in the
   README per step 6.

## What NOT to do

- Don't create a mutant catalog (`.mutation/mutants.json`) or a canary — both are per-review-loop
  and per-run respectively, never scaffolded.
- Don't reimplement anything `mutate.mjs` already does (anchor resolution, restore, classification,
  isolation) — the harness is config + a README, plus the `custom` parser if this project needs one.
