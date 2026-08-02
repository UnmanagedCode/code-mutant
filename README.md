# code-mutant

A [code-conductor](https://github.com/UnmanagedCode/code-conductor) plugin that automates the
mechanical half of **mutation-verified coverage proving** — an established, previously entirely
by-hand practice in this workspace: revert a fix in an isolated copy, confirm the test that claims
to cover it actually fails, and treat "passes either way" as proof the claim is false. The plugin
turns the by-hand parts (anchoring an edit, applying it, running the suite, parsing the output,
restoring the file, re-running prior rounds' mutants) into one shared runner. The judgment half —
which invariant is worth attacking, whether a survivor blocks landing — stays with the agents.

**Division of labour:** the **reviewer** authors and runs every mutant against the **implementer**'s
coverage claims; the implementer never mutates its own claims, because left to itself it only ever
picks mutants its own tests already catch. The **conductor** arbitrates survivors like any other
review finding — relay what's worth fixing, waive the rest explicitly. Findings only ever flow
upward; the implementer receives no mutants, only a report.

Contributions-only — no backend, no frontend, no MCP server. Enabling it never starts a process.

## Use as a code-conductor plugin

`conductor.plugin.json` declares two conventions and a `claudePlugin` root:

- **`mutation-harness`** (project convention, **scaffold-only** — no `file` fragment, so it adds
  nothing to a project's `CLAUDE.md`) — a one-time bootstrap directive
  (`scaffold/harness.md`) that builds `harness/mutation/` against the project's real test command:
  it decides `isolation` from the project's actual gates, picks the `runner` adapter by running the
  real test command once and matching its captured output, sets `baseBranch` to the branch the
  project actually merges into, and adds `.mutation/` to the project's own `.gitignore`. It creates
  neither a mutant catalog nor a canary — both are per-review/per-run.
- **`demand-mutation-verified`** (`scope: "conductor"`) — the plugin's only prompt fragment. Briefs
  the conductor to have the reviewer mutation-prove coverage claims via `/code-mutant:prove` rather
  than trust the implementer's report, and to handle the case where a project has no harness yet.
- **`claudePlugin: "."`** — this project root doubles as the Claude Code plugin root, so
  `skills/prove/SKILL.md` resolves as `/code-mutant:prove` for every worker, whether or not the
  project it's invoked in was ever scaffolded.

## The `/code-mutant:prove` skill

Reviewer-facing, invoked inside the review→refine loop (never by the implementer). Enumerates the
implementer's coverage claims, clears all three trust gates, re-runs the review's existing mutant
catalog for regressions, lists un-covered diff hunks via `candidates` (it
lists, the reviewer targets — no exhaustive one-per-hunk sweep), authors one minimal mutant per
claim/candidate, runs narrow with `--copy` preferred, and reports survivors as findings the
conductor can arbitrate without reading project code. Full flow: `skills/prove/SKILL.md`.

## The mutation harness — `harness/mutation/`

Built once per project by the scaffold above, committed to the project's repo (the *how* persists;
see [Artifact lifetime](#artifact-lifetime) below). `harness/mutation/config.json` fields:

| Field | Default | Meaning |
|---|---|---|
| `baselineCommand` | *required* | The project's real "run everything" command, used to measure a clean baseline before any mutant is trusted. |
| `testCommand` | *required* | The command run per mutant, containing a `{tests}` placeholder the runner substitutes with the narrowed scope (see [Narrowing](#narrowing-and-signal-grades)). |
| `runner` | *required* | Which output-parsing adapter to use — see [Adapters](#adapters). |
| `isolation` | `"in-place"` | `"copy"` or `"in-place"` — see [Isolation modes](#isolation-modes). Overridable per invocation with `--copy`/`--in-place`. |
| `preserve` | `[]` | Paths to symlink into an isolated copy rather than duplicate (e.g. `node_modules`). |
| `timeoutMs` | `120000` | Per-*command* wall-clock cap — it applies to every command the runner measures, `setup`/`teardown` included. A hung command classifies as `TIMEOUT`, not counted as a kill. |
| `jobs` | `1` | Parallelism for `copy`-mode runs; clamped to 1 in `in-place` mode, with a note, since concurrent mutation of one tree is unsafe. |
| `baseBranch` | *unset* | The branch `run`'s empty-diff-vs-base gate compares the working tree against — normally whatever the project merges into. Unset, that gate reports `not-established` and checks nothing (see [Three trust gates](#three-trust-gates)). `--base` overrides it per invocation. |
| `setup` / `teardown` | *unset* | Optional commands run around every measured command — the escape hatch for a DB reset, a build step, or a service that needs starting, without requiring project-local code. |

### Adapters

An adapter turns a test command's output into pass/fail/skip counts and failed-test names — or,
for a gate that emits no counts at all, `"exit-code"` reads the exit status alone (the degraded
signal grade; see [Narrowing and signal grades](#narrowing-and-signal-grades)). The intended
extension path is **`custom`: you write your own.** A project points `runner` at
`"custom"`, drops a `parse.mjs` beside its `config.json` exporting
`parse(stdout, stderr, exitCode)`, and proves it against output it captured from its own suite. The
`parse()` contract is specified in [`mutants.schema.md`](mutants.schema.md) (Appendix B). Adapters
that prove themselves useful across projects are the candidates for being pulled up into the plugin
later — that is how this list is meant to grow.

The shipped adapters are conveniences that happen to exist already, and they are not equally proven:

| `runner` | Status |
|---|---|
| `node-test`, `exit-code` | **Proven.** Both are driven end-to-end by this project's test suite — real commands, real temp git repos, the full mutate cycle. These are the pair in active use. |
| `pytest`, `vitest`, `dotnet` | **Parser-pinned only.** Each parser is tested against stdout/stderr captured from a real toolchain run (see [`test/fixtures/PROVENANCE.md`](test/fixtures/PROVENANCE.md)), so it parses real output rather than a guess at the format. But no full mutate cycle has ever been run against a real project on those stacks. Treat them as a starting point to verify, not as supported. |

Those five are the whole shipped set; anything else — Rust included — is a `custom` parser. Why one
is not shipped for a given stack is recorded in
[`test/fixtures/PROVENANCE.md`](test/fixtures/PROVENANCE.md).

### Isolation modes

- **`copy`** — the mutant runs against a scratch copy of the tree (including any uncommitted
  changes — never a clean clone from HEAD, which would silently test the wrong code). Restore is
  simply discarding the copy. Use for pure in-process unit tests, or when `--jobs` parallelism is
  wanted. This is what the reviewer should prefer, since it never touches the worktree it shares
  with the implementer.
- **`in-place`** — the mutant runs against the real tree, for gates that need one (a server boot, a
  build cache, absolute-path dependencies). Restore is a byte-snapshot replay over every path the
  mutant touched — including paths a `patch`-form mutant created or deleted, which are snapshotted
  as an explicit "absent" state — followed by an assertion that the tree is back to byte-identical.
  Restore is wired to `exit`/`SIGINT`/`SIGTERM`, so an interrupted run can't leave a mutation behind.
  Restore never uses `git checkout --` or `git apply --reverse` — both would silently destroy any
  uncommitted edits already in the file being mutated.

### Narrowing and signal grades

In **counted mode** (an adapter that parses pass/fail/skip counts and failed-test names), `{tests}`
substitutes the smallest scope that both includes every `expectFail`/`expectPass` test *and* still
lets the adapter observe a failure outside `expectFail` within that scope — in practice, file-path
granularity by default. This is what makes `IMPRECISE` detectable at all: narrowing to exactly the
named tests would make "a failure outside `expectFail`" unobservable by construction. In
**exit-code mode** (`runner: "exit-code"` — a gate with no pass/fail/skip counts, like `npx tsc
--noEmit` or a Playwright snap check) there is no substitution; the whole gate command runs, and a
per-mutant `narrowCommand` can override it. Every verdict is labeled with which grade produced it,
since an exit-code kill is not the same precision as a counted kill.

### Verdicts

| Verdict | Meaning |
|---|---|
| `KILLED` | Exactly the `expectFail` tests failed, and every `expectPass` test still passed. |
| `SURVIVED` | The suite stayed green *and* the command exited 0 — the finding: the coverage claim is false. |
| `IMPRECISE` | A compile/build break, or failures outside `expectFail` — the mutant itself is invalid (often an equivalent mutant) and needs rewriting smaller, not reporting as a finding. |
| `TIMEOUT` | The mutation hung the suite — flagged, not counted as a kill. |
| `ERROR` | No verdict was possible: an anchor is missing or ambiguous (a catalog stale against moved code), the replacement was a no-op, the narrowed scope was already broken or ran zero tests, or the command exited non-zero without naming a failing test. |

### Three trust gates

Before any verdict above is believable, three gates run first — and there is deliberately no way to
skip them short of `--allow-dirty`:

- **clean-tree** — mutation must run against committed state, so a survivor is re-runnable against a
  sha by anyone and a restore bug degrades from destroying unrecoverable work to a recoverable git
  object. Two checks: **dirty-tree** (`baseline` and `run` refuse an uncommitted or untracked
  worktree; `probe` only warns) and **empty-diff-vs-base** (`run` only — a tree with no diff against
  `baseBranch` has nothing committed to mutate, so mutating it would report a false clean sweep).
  A dirty-tree measurement is the recurring real-world failure this guards against.
- **baseline** — an unmutated run of `baselineCommand` in the same isolated copy, recording
  pass/fail/skip. It must be green.
- **canary** — a guaranteed-failing mutation the runner synthesizes at gate time, confirms comes
  back `KILLED`, then discards. It is never written to the repo. Without it, a test command that
  silently runs zero tests would report every mutant `SURVIVED` (every finding false), and one that
  always errors would report every mutant `KILLED` (a fake-clean sweep).

Each gate reports `passed`, `failed`, or **`not-established`** — a gate that could not run at all,
which must never be read as a pass. It does not fail the exit code, so exit 0 on its own does not
mean the gates held: an `exit-code`-grade harness always reports its canary that way at baseline
scope, and so does empty-diff-vs-base when no `baseBranch` is configured or it names the branch
`HEAD` is already on.

`--allow-dirty` overrides the dirty-tree refusal and nothing else. Every verdict from that
invocation is then labelled non-reproducible — a `repro` column reading `NO (dirty)` in the matrix,
`reproducible: false` in `--json`, top-level and on every result. Every report also records
`mutatedSha`, so a survivor can be pointed at the exact commit it was found against. The gate
records' full shapes are in [`mutants.schema.md`](mutants.schema.md#the-clean-tree-gate).

## The mutant catalog

Per-review, gitignored, lives at `.mutation/mutants.json`, owned by the reviewer. The full
per-entry field schema is specified in [`mutants.schema.md`](mutants.schema.md) — that file is the
authoritative format; this README only covers what the catalog is for.

A site is either an anchor + replacement (a substring swap, refused unless the anchor matches
exactly once and the replacement isn't a no-op) or a unified `patch` applied with `git apply`, for
structural mutations an anchor can't express (reordering two migrations, say) — that residue stays
hand-authored; the runner doesn't invent structural edits.

## Artifact lifetime

| Artifact | Lifetime | Committed? |
|---|---|---|
| **Harness** (`harness/mutation/config.json`, its README, an optional `parse.mjs`) | Project-level — the *how*. | Yes, built once by the scaffold. |
| **Canary** | One gate check. | No — never written to the repo. |
| **Mutant catalog + results** (`.mutation/`) | One review loop — the *what*, for one task. | No — gitignored, dies with the worktree. |

Mutants are scaffolding: once a mutant proves a test stands, the *test* is the durable artifact and
the mutant has done its job. Keeping a catalog past merge buys little (nothing in the workspace's
practice has ever wanted a mutant after merge) and costs real upkeep, since an anchor-based mutant
is coupled to exact source text and rots on the next refactor of code nobody is currently reviewing.

## CLI — `mutate.mjs`

Stack-agnostic; the test command is always a shell string. Invoked directly, from wherever
`harness/mutation/config.json` is resolved for the current project:

```
node mutate.mjs baseline                    [--copy|--in-place] [--allow-dirty] [--json]
node mutate.mjs run [--id <id> ...] [--all] [--copy|--in-place] [--jobs N]
                    [--base <branch>] [--allow-dirty] [--json]
node mutate.mjs validate                    [--json]
node mutate.mjs probe --file <path> --anchor <text> --replace <text>
                      --expect-fail <test> [...] [--expect-pass <test> ...]
                      [--copy|--in-place] [--json]
node mutate.mjs candidates --base <branch>  [--json]
```

`mutate.mjs --help` is authoritative for what each flag means; this section covers what each
subcommand is *for*.

- **`baseline`** — runs the trust gates and stops. Measures `baselineCommand` in the configured
  isolation mode, records pass/fail/skip, and synthesizes a canary. Nothing else in the run is
  trustworthy until this is green and the canary comes back `KILLED`.
- **`run`** — runs one or more catalog mutants (`.mutation/mutants.json`) by `--id`, or every mutant
  with `--all`. Per mutant: resolve anchor(s)/patch → refuse an ambiguous or no-op edit → measure
  the narrow scope unmutated → apply in the isolated copy → run the narrowed `testCommand` →
  classify → restore. The only subcommand that runs the empty-diff-vs-base gate.
- **`validate`** — resolves every catalog site against the working tree and reports what would
  refuse, **running no tests**, so it returns in about a second instead of costing a baseline per
  stale anchor. A pre-flight, *not* a gate: it establishes nothing and emits no verdict, and exit 0
  means "the catalog resolves against this tree", never "the gates passed". Problems (a stale
  anchor, a mutant that can never read `KILLED`) exit 4; warnings never affect the exit code. The
  severity contract and per-code table are in
  [`mutants.schema.md`](mutants.schema.md#pre-flight-validation).
- **`probe`** — an ad-hoc single mutation with no catalog entry, for exploring a mutation before
  adding it to the catalog. Takes the site inline (`--file`/`--anchor`/`--replace`) plus the
  expected failing test(s), rather than reading `mutants.json`. The escape hatch: the clean-tree
  gate is a warning here, not a refusal.
- **`candidates --base <branch>`** — lists diff hunks (relative to `<branch>`) that no catalog
  mutant currently covers. Lists only; it never mutates anything — the reviewer picks which hunks
  are invariant-bearing and authors mutants for them via `run`/a catalog edit. Needs no harness.

**Shared flags:** `--copy` / `--in-place` override `config.json`'s `isolation` for one invocation —
the reviewer should default to `--copy`, since it doesn't own the shared worktree. `--json` puts the
machine report on stdout instead of the printed matrix; either way `run` and `probe` always write
the same object to `.mutation/results/<runId>.json`, and refuse outright if `.mutation/` isn't
gitignored. Exit code is non-zero whenever any un-waived mutant survived — a signal a conductor can
gate on, unlike a self-reported reviewer verdict — and distinguishes a failed gate and a
no-verdict run from a clean sweep; the full table is in
[`mutants.schema.md`](mutants.schema.md#exit-codes).

A scaffolded project documents how to invoke the harness for itself in its own
`harness/mutation/README.md`, written against the commands that project is actually tested with.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). Copyright © 2026 UnmanagedCode. See the [LICENSE](LICENSE) file for details.
