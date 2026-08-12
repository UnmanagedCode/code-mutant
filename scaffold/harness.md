# Scaffold a mutation-verification harness

Build a project-local mutation-testing harness at `harness/mutation/`, driven by the shared
`code-mutant` runner (`mutate.mjs`) as a sibling project — so a reviewer can later run
`/code-mutant:prove` against this project. This is a one-time bootstrap.

## What to build

1. `harness/mutation/config.json` — required: `baselineCommand`, `testCommand` (with a `{tests}`
   placeholder), `runner`. Optional, each with a default the runner applies if you omit it:
   `isolation`, `preserve`, `timeoutMs`, `jobs`, `baseBranch`, `setup`/`teardown` (`--help` lists
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
   - `pytest`, `vitest`, `dotnet` — the parser is pinned to captured fixtures but has never driven
     a full mutate cycle, so check it against the output you just captured rather than assuming it
     fits, and write a `custom` parser instead if it disagrees.
   - Nothing matches — write the `custom` parser. That is the intended path, not a last resort:
     `harness/mutation/parse.mjs` (that exact filename, beside `config.json`) exporting
     `parse(stdout, stderr, exitCode)`. Prove it against the captured output before finishing.

   A counted-grade command must exit 0 whenever no test failed: one that chains a lint or guardrail
   step exiting non-zero on its own fails the baseline gate (`outcome: "failed"`), so scope
   `baselineCommand`/`testCommand` to the test run itself.
4. **Set `baseBranch`** to the branch this project actually merges into (`main`, `master`, or
   whatever its real integration branch is). Left unset, `run`'s empty-diff-vs-base gate reports
   `not-established` and checks nothing, so a review of a branch with no committed work would read
   as a clean sweep.
5. Write `harness/mutation/README.md` documenting how to invoke the harness for *this* project.
   Command syntax and flags are `mutate.mjs`'s own CLI, so read it directly (`--help` or its
   source) rather than copying examples from another project's harness, which can drift. Call
   nothing in it verified unless you ran it in this project — name the command and what it
   produced, or don't make the claim.
6. Add `.mutation/` to this project's `.gitignore` (per the workspace git-hygiene convention —
   verify the pattern actually matches via `git status` before the first commit that touches it).

## What NOT to do

- Don't create a mutant catalog (`.mutation/mutants.json`) or a canary — both are per-review-loop
  and per-run respectively, never scaffolded.
- Don't reimplement anything `mutate.mjs` already does (anchor resolution, restore, classification,
  isolation) — the harness is config + a README, plus the `custom` parser if this project needs one.
