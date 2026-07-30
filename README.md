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
  real test command once and matching its captured output, and adds `.mutation/` to the project's
  own `.gitignore`. It creates neither a mutant catalog nor a canary — both are per-review/per-run.
- **`demand-mutation-verified`** (`scope: "conductor"`) — the plugin's only prompt fragment. Briefs
  the conductor to have the reviewer mutation-prove coverage claims via `/code-mutant:prove` rather
  than trust the implementer's report, and to handle the case where a project has no harness yet.
- **`claudePlugin: "."`** — this project root doubles as the Claude Code plugin root, so
  `skills/prove/SKILL.md` resolves as `/code-mutant:prove` for every worker, whether or not the
  project it's invoked in was ever scaffolded.

## The `/code-mutant:prove` skill

Reviewer-facing, invoked inside the review→refine loop (never by the implementer). Enumerates the
implementer's coverage claims, gates on a green baseline plus a synthesized canary, re-runs the
review's existing mutant catalog for regressions, lists un-covered diff hunks via `candidates` (it
lists, the reviewer targets — no exhaustive one-per-hunk sweep), authors one minimal mutant per
claim/candidate, runs narrow with `--copy` preferred, and reports survivors as findings the
conductor can arbitrate without reading project code. Full flow: `skills/prove/SKILL.md`.

## The mutation harness — `harness/mutation/`

Built once per project by the scaffold above, committed to the project's repo (the *how* persists;
see [Artifact lifetime](#artifact-lifetime) below). `harness/mutation/config.json` fields:

| Field | Meaning |
|---|---|
| `baselineCommand` | The project's real "run everything" command, used to measure a clean baseline before any mutant is trusted. |
| `testCommand` | The command run per mutant, containing a `{tests}` placeholder the runner substitutes with the narrowed scope (see [Narrowing](#narrowing-and-signal-grades)). |
| `runner` | Which output-parsing adapter to use: a shipped one (`node-test`, `pytest`, `vitest`, `dotnet`), `"exit-code"` for a gate with no pass/fail/skip counts (the degraded signal grade — kill/no-kill only), or `"custom"`, pointing at a project-local `.mjs` exporting `parse(stdout, stderr, exitCode)` for a stack with structured output no shipped adapter parses. |
| `isolation` | `"copy"` or `"in-place"` — see [Isolation modes](#isolation-modes). Overridable per invocation with `--copy`/`--in-place`. |
| `preserve` | Paths to symlink into an isolated copy rather than duplicate (e.g. `node_modules`). |
| `timeoutMs` | Per-mutant wall-clock cap; a hung command classifies as `TIMEOUT`, not counted as a kill. |
| `jobs` | Parallelism for `copy`-mode runs. |
| `setup` / `teardown` | Optional commands run around each mutant — the escape hatch for a DB reset, a build step, or a service that needs starting, without requiring project-local code. |

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
| `SURVIVED` | The suite stayed green — the finding: the coverage claim is false. |
| `IMPRECISE` | A compile/build break, or failures outside `expectFail` — the mutant itself is invalid (often an equivalent mutant) and needs rewriting smaller, not reporting as a finding. |
| `TIMEOUT` | The mutation hung the suite — flagged, not counted as a kill. |
| `ERROR` | An anchor is missing or ambiguous — the catalog is stale against moved code. |

### Two trust gates

Before any verdict above is believable: **baseline** (an unmutated run in the same isolated copy,
recording pass/fail/skip — a dirty-tree measurement is the recurring real-world failure this
guards against) must be green, and a **canary** — a guaranteed-failing mutation the runner
synthesizes at gate time, confirms comes back `KILLED`, then discards — must fire. The canary is
never written to the repo; without it, a test command that silently runs zero tests would report
every mutant `SURVIVED` (every finding false), and one that always errors would report every mutant
`KILLED` (a fake-clean sweep).

## The mutant catalog

Per-review, gitignored, lives at `.mutation/mutants.json`, owned by the reviewer. The full
per-entry field schema (`id`, `invariant`, `sites[]`, `expectFail`/`expectPass`,
`whyNotEquivalent`, optional `narrowCommand`, optional `waived`) is specified in
[`mutants.schema.md`](mutants.schema.md) — that file is the authoritative format; this README only
covers what the catalog is for.

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
node mutate.mjs baseline                    [--copy|--in-place] [--json]
node mutate.mjs run [--id <id> ...] [--all] [--copy|--in-place] [--json]
node mutate.mjs probe --file <path> --anchor <text> --replace <text> --expect-fail <test> [...] [--copy|--in-place] [--json]
node mutate.mjs candidates --base <branch>  [--json]
```

- **`baseline`** — runs `baselineCommand` in the configured isolation mode and records pass/fail/skip
  counts. Must be green before any other verdict in this run is trusted.
- **`run`** — runs one or more catalog mutants (`.mutation/mutants.json`) by `--id`, or every mutant
  with `--all`. Per mutant: resolve anchor(s)/patch → refuse an ambiguous or no-op edit → apply in
  the isolated copy → run the narrowed `testCommand` → classify → restore.
- **`probe`** — an ad-hoc single mutation with no catalog entry, for exploring a mutation before
  adding it to the catalog. Takes the site inline (`--file`/`--anchor`/`--replace`) plus the
  expected failing test(s), rather than reading `mutants.json`.
- **`candidates --base <branch>`** — lists diff hunks (relative to `<branch>`) that no catalog
  mutant currently covers. Lists only; it never mutates anything — the reviewer picks which hunks
  are invariant-bearing and authors mutants for them via `run`/a catalog edit.

**Shared flags:** `--copy` / `--in-place` override `config.json`'s `isolation` for one invocation
(the reviewer should default to `--copy` — it doesn't own the shared worktree); `--json` emits a
machine-readable report (used alongside, or instead of, the printed `id | invariant | verdict |
expected | actual | Δcounts` matrix). Exit code is non-zero whenever any un-waived mutant survived —
a signal a conductor can gate on, unlike a self-reported reviewer verdict.

For running this project's own harness against itself (`code-mutant` is Node, tested with
`node --test`) or a scaffolded project's harness, see that harness's own README — command usage
there is documented against the actual project it was scaffolded for.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). Copyright © 2026 UnmanagedCode. See the [LICENSE](LICENSE) file for details.
