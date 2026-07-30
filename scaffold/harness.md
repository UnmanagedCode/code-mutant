# Scaffold a mutation-verification harness

Build a project-local mutation-testing harness at `harness/mutation/`, driven by the shared
`code-mutant` runner (`mutate.mjs`) as a sibling project — so a reviewer can later run
`/code-mutant:prove` against this project. This is a one-time bootstrap.

## What to build

1. `harness/mutation/config.json` — `baselineCommand`, `testCommand` (with a `{tests}`
   placeholder), `runner`, `isolation`, `preserve`, `timeoutMs`, `jobs`, and optional
   `setup`/`teardown`. Base every value on this project's *real* commands (its actual
   `package.json` scripts, CI config, or whatever the test suite is actually invoked with) — don't
   guess or reuse another project's values.
2. **Pick `isolation`** from this project's real gates — and only fall back to a default when
   they're genuinely ambiguous:
   - `"in-place"` — a mutant's command boots a server, needs a build cache, or depends on absolute
     paths (e.g. a Playwright/browser gate, Next.js, anything with real filesystem state). Also the
     fallback when the project's gates don't clearly call for either mode.
   - `"copy"` — pure in-process unit tests, or when `--jobs` parallelism is wanted.
3. **Pick `runner`** by actually running the project's test command once and capturing its real
   stdout/stderr. Match it against the shipped adapters (`node-test`, `pytest`, `vitest`,
   `dotnet`) first. If the command emits no pass/fail/skip counts at all — a gate like
   `npx tsc --noEmit` or `npm run snap` — pick `runner: "exit-code"` instead, never a `custom`
   parser for output that has nothing to parse; its verdicts are the degraded signal grade
   (kill/no-kill only), and a per-mutant `narrowCommand` is how an exit-code gate gets narrowed.
   Only write a project-local `custom` parser (a `.mjs` exporting `parse(stdout, stderr,
   exitCode)`) when the command *does* produce structured output but none of the shipped adapters
   parse it — then prove the parser against that captured output before finishing, not just assume
   it works.
4. Write `harness/mutation/README.md` documenting how to invoke the harness for *this* project.
   Command syntax and flags are `mutate.mjs`'s own CLI, so read it directly (`--help` or its
   source) rather than copying examples from another project's harness, which can drift.
5. Add `.mutation/` to this project's `.gitignore` (per the workspace git-hygiene convention —
   verify the pattern actually matches via `git status` before the first commit that touches it).

## What NOT to do

- Don't create a mutant catalog (`.mutation/mutants.json`) or a canary — both are per-review-loop
  and per-run respectively, never scaffolded.
- Don't reimplement anything `mutate.mjs` already does (anchor resolution, restore, classification,
  isolation) — the harness is config + a README, not code, except the narrow `custom`-parser case
  above.
