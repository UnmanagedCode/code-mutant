# code-mutant

A [code-conductor](https://github.com/UnmanagedCode/code-conductor) plugin that automates the
mechanical half of **mutation-verified coverage proving** — an established, previously entirely
by-hand practice in this workspace: revert a fix in an isolated copy, confirm the test that claims
to cover it actually fails, and treat "passes either way" as proof the claim is false. The plugin
turns the by-hand parts (anchoring an edit, applying it, running the suite, parsing the output,
restoring the file, re-running prior rounds' mutants) into one shared runner, and retires the
by-hand version: a prover with no harness reports the absence and proceeds — it never reverts a
fix by hand in a copy of its own. The judgment half — which invariant is worth attacking, whether a
survivor blocks landing — stays with the agents.

**Division of labour:** the **prover** authors and runs every mutant against the **implementer**'s
coverage claims; the implementer never mutates its own claims, because left to itself it only ever
picks mutants its own tests already catch — and, being the same party, it proves nothing the
prover's run won't. The **conductor** arbitrates survivors like any other review finding — relay
what's worth fixing, waive the rest explicitly. Findings only ever flow upward; the implementer
receives no mutants, only a report.

**The prover is its own worker**, spawned to mutation-prove and nothing else — never the
implementer, and never a lens reviewer (correctness, security, …) with proving bolted onto its
brief. It is a role, not a stage in anyone's workflow: `code-mutant` defines no stage and expects
none, so there is no stage named after this role for a conductor to find. Spawn it into whatever
slot the workflow already opens for a worker running alongside the implementer. Unlike the
inspect-only reviewers it runs beside, it **writes to the implementer's worktree** — under
`in-place` isolation the mutant is applied there and byte-restored after each measurement — so
exactly one prover runs per round: a second concurrent in-place invocation is **refused** with
`inplace-locked` (exit 2) before it mutates anything, so the rule is enforced rather than assumed
— see the cross-process lock under [Isolation modes](#isolation-modes).

The implementer's own coverage duty is to *state*, not to prove: name which invariant each test
pins, and stop there. It is never briefed to break source to watch a test fail — no mutating,
reverting or stubbing, wherever the mutant would live, since a hand-rolled mutant under `/tmp`
evades a path-scoped `.mutation/` ban while proving nothing the prover's run won't, and a
hand-rolled run that hangs leaves the tree mutated. Test-first ordering — write the test, watch it
fail, then write the code — is the only implementer-side failure evidence there is; after the fact
no unfixed behaviour remains to run against, only a mutant.

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
  the conductor to spawn a dedicated prover to mutation-prove coverage claims via
  `/code-mutant:prove` rather than trust the implementer's report, and to treat a project with no
  harness as configured for none.
- **`claudePlugin: "."`** — this project root doubles as the Claude Code plugin root, so
  `skills/prove/SKILL.md` resolves as `/code-mutant:prove` for every worker, whether or not the
  project it's invoked in was ever scaffolded.

## The `/code-mutant:prove` skill

Prover-facing, invoked inside the review→refine loop (never by the implementer). Enumerates the
implementer's coverage claims, clears all three trust gates, re-runs the review's existing mutant
catalog for regressions, lists un-covered diff hunks via `candidates` (it
lists, the prover targets — no exhaustive one-per-hunk sweep), authors one minimal mutant per
claim/candidate, runs narrow in the project's configured isolation mode, and reports
survivors as findings the conductor can arbitrate without reading project code. Full flow:
`skills/prove/SKILL.md`.

## The mutation harness — `harness/mutation/`

Built by the scaffold above — once, in a project opted into mutation testing — and committed to the
project's repo (the *how* persists; see [Artifact lifetime](#artifact-lifetime) below).
`harness/mutation/config.json` fields:

| Field | Default | Meaning |
|---|---|---|
| `baselineCommand` | *required* | The project's real "run everything" command, used to measure a clean baseline before any mutant is trusted. |
| `testCommand` | *required* | The command run per mutant, containing a `{tests}` placeholder the runner substitutes with the narrowed scope (see [Narrowing](#narrowing-and-signal-grades)). |
| `runner` | *required* | Which output-parsing adapter to use — see [Adapters](#adapters). |
| `isolation` | `"in-place"` | `"copy"` or `"in-place"` — see [Isolation modes](#isolation-modes). Overridable per invocation with `--copy`/`--in-place`. |
| `preserve` | `[]` | Paths to symlink into an isolated copy rather than duplicate (e.g. `node_modules`). |
| `timeoutMs` | `120000` | Per-*command* wall-clock **ceiling** — the fallback for any command with no like-for-like reference (the baseline, a narrow baseline, `setup`/`teardown`). A command killed at its deadline is never counted as a kill; which verdict it gets depends on which command hung — see the `TIMEOUT` row under [Verdicts](#verdicts). |
| `hang` | `{factor: 10, floorMs: 10000}` | The adaptive deadline for a command that *does* have a reference — a mutant run, or a canary attempt — computed as `min(timeoutMs, max(floorMs, factor × referenceMs))`, so it is only ever tighter than `timeoutMs`, never looser. `factor: 0` disables it; `floorMs: 0` removes the floor. **The floor dominates for fast scopes:** at the defaults, any reference under 1 s yields exactly `floorMs`, so on a sub-second file scope `factor` has no effect and the deadline is a flat 10 s. Below `floorMs / factor`, tune `floorMs`, not `factor`. |
| `jobs` | `1` | Concurrent mutants in `copy` mode — each worker owns one copy exclusively for its whole life, asserted per run (`lib/occupancy.mjs`), never merely intended. Clamped to 1 in `in-place` mode, with a note, since concurrent mutation of one tree is unsafe. `jobs > 1` also runs the *project's* suite that many times at once — see the unsafe-suite list under [Isolation modes](#isolation-modes). |
| `baseBranch` | *unset* | The branch `run`'s empty-diff-vs-base gate and `candidates` compare the working tree against — normally whatever the project merges into. Unset, that gate reports `not-established` and checks nothing (see [Three trust gates](#three-trust-gates)), and `candidates` refuses without `--base`. `--base` overrides it per invocation, on each command separately. A base far behind the tree is fine: the gate costs the same at any distance, and both commands print the resolved base with its distance (commits ahead, files, +/-). |
| `setup` / `teardown` | *unset* | Optional commands run around every measured command — the escape hatch for a DB reset, a build step, or a service that needs starting, without requiring project-local code. |

### Adapters

An adapter turns a test command's output into pass/fail/skip counts and failed-test names — or,
for a gate that emits no counts at all, `"exit-code"` reads the exit status alone (the degraded
signal grade; see [Narrowing and signal grades](#narrowing-and-signal-grades)). The intended
extension path is **`custom`: you write your own.** A project points `runner` at
`"custom"`, drops a `parse.mjs` beside its `config.json` exporting
`parse(stdout, stderr, exitCode)`, and proves it against output it captured from its own suite. The
full export contract is specified in [`mutants.schema.md`](mutants.schema.md) (Appendix B). Adapters
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
  wanted. **A copy is not a git repository** — `copyTree` excludes top-level `.git`
  (`lib/workspace.mjs`), for a worktree and an ordinary clone alike, so a suite that shells out to
  git inside the tree fails here and takes the baseline gate with it. Its no-trace assertion is
  about the copy's own integrity: no mutation code-mutant applied is still sitting in it. Residue
  there is measured by every later mutant that
  runs in the same copy, so it fails the run with exit 3, not a coverage finding.
- **`in-place`** — the mutant runs against the real tree, for gates that need one (a server boot, a
  build cache, absolute-path dependencies). Restore is a byte-snapshot replay over every path the
  mutant touched — including paths a `patch`-form mutant created or deleted, which are snapshotted
  as an explicit "absent" state — followed by an assertion that the tree is back to byte-identical.
  Restore is wired to `exit`/`SIGINT`/`SIGTERM`, so an interrupted run can't leave a mutation behind.
  Restore never uses `git checkout --` or `git apply --reverse` — both would silently destroy any
  uncommitted edits already in the file being mutated.

**In-place takes a cross-process lock, and a second invocation is refused rather than serialised.**
`jobs` is clamped to 1 in-place, but that clamp binds inside one process; two sibling `mutate.mjs`
processes against one worktree would interleave their snapshot and restore, so one would measure
its baseline against the other's applied mutation. So every in-place `run`/`baseline`/`probe`
publishes a claim file in `<git-dir>/code-mutant-inplace.lock.d/` — `.git` for the main checkout,
`.git/worktrees/<name>` for a linked worktree, so two worktrees of one repo lock independently, and
`git status` never reports it. If any other claim there cannot be shown to belong to a dead
process, the run refuses with the `inplace-locked` gate code (exit 2, [Refusals](mutants.schema.md#refusals))
naming the holding pid, **before** the clean-tree gate and before anything is mutated. `copy` mode
takes no lock at all and still runs `jobs > 1`: every worker there owns its own tree.

Each claim carries the holder's pid, its `/proc` process start time and the machine's boot id, so a
claim left by a crashed, pid-reused or rebooted-away process is *ignored and swept* rather than
wedging the worktree. **No crash state needs a human**: a killed holder leaves one claim, and the
next run classifies it dead, ignores it and deletes it. Four things still refuse:

- **Simultaneous starts may all refuse, and often will.** Each process publishes its claim before it
  lists the directory, so at most one can ever hold — but when N processes genuinely start together,
  all of them seeing each other is the *typical* outcome, not a rare interleaving: a 12-way fan-out
  would plausibly refuse all 12. Nothing is mutated and each one withdraws its own claim, so the fix
  is to **start them one at a time**, not to re-run the same fan-out.
- **A claim written by another host** (a `.git` on a network filesystem) blocks until removed by
  hand: a pid liveness check about a different machine means nothing.
- **A hand-edited or truncated claim** blocks until removed by hand. The harness cannot write one —
  a claim is published complete, by `link(2)` from a temp file — and a claim that cannot be *proven*
  dead is deliberately never deleted, since deleting one whose payload merely failed to read would
  admit a second holder.
- **A pid-reused holder on a host with no `/proc`** cannot be told from a live one, so it blocks
  until that pid exits.

In each case `rm` the named claim in `<git-dir>/code-mutant-inplace.lock.d/` once no code-mutant
process is running against the tree, or use `--copy`.

**`--jobs N` in copy mode runs the project's suite N times concurrently, in N copies.** Each copy is
its own tree, but a suite is not automatically safe to run against itself. Use `jobs=1` if the suite
binds a fixed TCP port, writes a fixed temp or data directory, shares a database or an on-disk
fixture it mutates in place, writes a shared build/package cache, or depends on the checkout's
absolute path. `preserve` entries are **symlinked** into every copy, so a preserved path is shared
writable state across all workers *and* the real tree — safe for a read-only `node_modules`, not for
anything the suite writes. The CLI warns whenever `jobs > 1`, and repeats the caveat on the
report. The runner's own copy-per-worker isolation is reconciled in the field — 13 runs over a
10-mutant catalog at `jobs` 1/2/4, zero verdict disagreements across 130 observations (code-kanban,
2026-08-12) — so a `--jobs N` verdict a serial re-run contradicts is a hazard from the list above
before it is a runner bug.

### Narrowing and signal grades

In **counted mode** (an adapter that parses pass/fail/skip counts and failed-test names), `{tests}`
substitutes the smallest scope that both includes every `expectFail`/`expectPass` test *and* still
lets the adapter observe a failure outside `expectFail` within that scope — in practice, file-path
granularity by default. This is what makes `IMPRECISE` detectable at all: narrowing to exactly the
named tests would make "a failure outside `expectFail`" unobservable by construction. In
**exit-code mode** (`runner: "exit-code"` — a gate with no pass/fail/skip counts, like `npx tsc
--noEmit` or a Playwright snap check) there is no substitution; the whole gate command runs, and a
per-mutant `narrowCommand` can override it. Every verdict is labeled with which grade produced it,
since an exit-code kill is not the same precision as a counted kill. `--learn` reads
`expectFail`/`expectPass` as scope hints only, never grades against them, and falls back to
`baselineCommand` (the whole suite) when a mutant names no ref at all — discovery has no scope to
narrow to. **The canary gate follows the narrowing**: the command that judges a mutant is the command
the canary is established against (see the canary bullet under [Three trust
gates](#three-trust-gates)).

### Verdicts

| Verdict | Meaning |
|---|---|
| `KILLED` | Exactly the `expectFail` tests failed, and every `expectPass` test still passed. |
| `SURVIVED` | The suite stayed green *and* the command exited 0 — the finding: the coverage claim is false. |
| `IMPRECISE` | A compile/build break, or failures outside `expectFail` — the mutant itself is invalid (often an equivalent mutant) and needs rewriting smaller, not reporting as a finding. |
| `TIMEOUT` | The **mutant run** was killed at its deadline — flagged, not counted as a kill. The same scope completed unmutated moments earlier, so the mutation is what hung it: rewrite it smaller. (`hang.blame` is always `mutation` here.) A hung *unmutated* scope is an `ERROR`, not this — see the row below. |
| `ERROR` | No verdict was possible: an anchor is missing or ambiguous (a catalog stale against moved code), the replacement was a no-op, the narrowed scope was already broken or ran zero tests, **the narrowed scope was killed at its deadline before any mutation was applied** (`scope-timed-out`, `hang.blame: suite` — a project defect to report upward; rewriting or dropping the mutant cannot fix it), the command exited non-zero without naming a failing test, or one of the three isolation-integrity checks below failed. An ungraded result is never shape-identical to a survivor — see [the ungraded-result shape](mutants.schema.md#the-shape-of-an-ungraded-result). |
| `LEARNED` | `--learn` mode only: the observed failing set, reported without grading. Never produced by a graded run. |

`Reason.WORKSPACE_OCCUPIED`, `Reason.WORKSPACE_RESIDUE` and `Reason.MUTATION_NOT_INTACT`
(`lib/classify.mjs`) say the tree a command measured was not the tree the result would claim: two
mutants in one workspace, foreign mutation bytes left in it, or a mutation that did not survive its
own measured run. All three are `ERROR` (exit 5), never `SURVIVED` and never a downgraded verdict —
a race that can fake a survivor can fake a kill just as easily and in silence, so nothing is known
in either direction. See `lib/occupancy.mjs`.

Don't confuse those with `inplace-locked`: it is a **gate** code, not a `Reason` — run-level, exit
2, refused before any mutant is planned and before anything is measured, whereas the three above are
per-mutant and detected after the fact. See the cross-process lock under
[Isolation modes](#isolation-modes).

### Three trust gates

Before any verdict above is believable, three gates run first — and there is deliberately no way to
skip them short of `--allow-dirty`. The baseline — and a baseline-scope canary — may be *served*
rather than re-measured when this exact tree has already been measured ([Gate
caching](#gate-caching)); a served gate is labelled and its outcome is verbatim, so it is never a
skipped one.

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
  **Which command it runs:** the one that actually judges the mutant — each distinct narrowed scope,
  once — because in counted mode no verdict comes from `baselineCommand`. It falls back to
  `baselineCommand` for anything it cannot soundly narrow, and the six conditions are enumerated in
  full in [`mutants.schema.md`](mutants.schema.md#the-canarys-scope): `narrowTo: "names"` (the name
  filter excludes the injected canary by construction), a per-mutant `narrowCommand`, exit-code
  grade, an adapter whose refs do not name files (`dotnet`, or a `custom` parser with its own
  `scopeOf`), a `testCommand` with no `{tests}`, a narrow command identical to `baselineCommand`
  (including `--learn`'s no-refs fallback), and a ref naming a file this tree does not have — plus
  `baseline`/an empty catalog/a fully resumed run, which have no judging command at all. A scope that
  *cannot* be shown to observe a failure `ERROR`s **its own mutants** (`canary-not-established`, a
  `PARTIAL` gate) rather than failing the whole run — but a run where nothing at all could be attested
  is still the wholesale refusal it always was.

Each gate reports `passed`, `failed`, or **`not-established`** — a gate that could not run at all,
which must never be read as a pass. It does not fail the exit code, so exit 0 on its own does not
mean the gates held: an `exit-code`-grade harness always reports its canary that way at baseline
scope, and so does empty-diff-vs-base when no `baseBranch` is configured or it names the branch
`HEAD` is already on. The canary has a fourth: **`partial`** — some judging command was attested and
some was not, so the mutants judged by an unattested one are `ERROR`, not findings. It does not fail
the exit code either; those mutants drive it to 5 through `noVerdict`.

`--allow-dirty` overrides the dirty-tree refusal and nothing else. Every verdict from that
invocation is then labelled non-reproducible — a `repro` column reading `NO (dirty)` in the matrix,
`reproducible: false` in `--json`, top-level and on every result. Every report also records
`mutatedSha`, so a survivor can be pointed at the exact commit it was found against. The gate
records' full shapes are in [`mutants.schema.md`](mutants.schema.md#the-clean-tree-gate).

### Gate caching

The **baseline** gate is a fixed cost paid once per invocation, independent of mutant count — which
is what makes it cacheable. Measured at ~135,000 ms — **98.6% of a single-mutant invocation** on this
workspace's own suite — *before the canary was narrowed*, when the whole gate floor was two full
`baselineCommand` runs and so was fixed end to end. It is now one full run plus one narrow run per
resolved scope, and only the full run is fixed: a narrow canary is one run per scope, so it scales
with the mutants in the run (see [Where a run's wall time went](#where-a-runs-wall-time-went)). The baseline record is cached at **`.mutation/gates/<key>.json`**
and served on a repeat run against an unchanged tree; the canary record is cached **only when it ran
at baseline scope**.

The key covers a **tree digest** (`HEAD^{tree}` plus a byte hash of every path `git status` reports,
so a hit means *byte-identical worktree*, not *same commit*), the resolved commands, the adapter,
the isolation mode, a digest of this harness's own source, and the node version/platform/arch. Any
of those differing is a miss. A tree no key can describe — an unborn HEAD, or a path git names whose
bytes it cannot read, such as an untracked embedded repository or a submodule with dirty contents —
is a **forced miss that writes nothing**, since an entry filed under a key that cannot tell its own
tree apart is exactly the false hit the cache must not produce. Deliberately **not** in the key: `jobs` (the gates run serially in
Phase A, before any concurrency exists), the gitignored `.mutation/` catalog — so reworking an
`IMPRECISE` mutant and re-running costs no gates — and **gitignored state the suite reads**
(`node_modules/`, a `.env`, a local DB, environment variables). That last one is the one real
exposure: `--remeasure-gates` skips the lookup, measures both gates in full and overwrites the entry,
and is the correction path when a key matches but something outside it moved.

**A narrow-scope canary is never served from cache, by design** — it attests about commands derived
from the catalog, which the key deliberately does not cover, so a narrowing run measures it every
time (~1 narrow run per scope) and the entry records `canary: null`. That is also what keeps the
key's reason for excluding the catalog true: the cached canary really is a property of the command
and not of the mutants.

A served gate is never dressed up as a measured one: its outcome is verbatim (`not-established` stays
`not-established`), `fromCache: true` sits beside it in `--json` and on the printed gate line, and the
report carries a `GATES FROM CACHE` banner — or `BASELINE FROM CACHE`, when the canary was measured
here. An entry is written only by a run that proved it left no trace, so a run killed mid-mutation
re-pays the gates rather than caching a tree it may have poisoned. Full contract — key inputs, write conditions, the crash-window ordering — is in
[`mutants.schema.md`](mutants.schema.md#caching-the-gates).

### Where a run's wall time went

**Look at the printed `Cost` block first** — it sits under `Trust gates` in every `run`, `probe` and
`baseline` summary, needs no `--json`, and prints on a failed-gate run too. Three buckets, each with
its share of `totalMs`:

| Bucket | What it is |
|---|---|
| `gatesMs` | Mostly, but **not always entirely, fixed per invocation** — the block names the fixed part when they differ. A canary at `scope: "baseline"` is a whole-suite run and is fixed; a `"narrow"` one is a run per *distinct* scope, so it scales with the mutants in the run and batching cannot spread it. `0` means **no gate command ran here** — in practice both were served from cache (see [Gate caching](#gate-caching)), though a gate record can also carry `durationMs: 0` with no cache involved. On a narrowing run against a cached baseline, `gatesMs` covers the canary only, since a narrow canary is never cached. |
| `narrowBaselinesMs` | One measured command per *distinct* scope, so N mutants at one scope cost one entry. |
| `mutantsMs` | A sum of per-mutant wall clocks, so under `--jobs N` it legitimately exceeds `totalMs` and prints above 100%. |

A share renders `-` when `totalMs` is `0`, and a bucket renders `-` when it is absent — never `0.0%`
for a measurement that never happened. Field-by-field contract:
[`mutants.schema.md`](mutants.schema.md#where-a-runs-wall-time-went).

**The `FIXED COST DOMINATES` note.** Emitted when the **fixed** part of `gatesMs` is `>= 10 ×` the
measurement it bought (`narrowBaselinesMs + mutantsMs`) **and** the catalog still holds mutants this
invocation did not carry. Both conjuncts are required, and the threshold is the constant
`FIXED_COST_DOMINANCE_RATIO` in `lib/report.mjs` — its only home.

The numerator is the fixed part rather than the whole bucket because that is the only cost more
mutants per invocation can amortise. So a narrowing run whose baseline was served from cache is
silent — what it re-paid was a narrow canary, which batching would *add* to, not spread — while a
`run` that reached `scope: "baseline"` (nothing narrow-canary-eligible) really did re-pay a whole
suite and still fires.

It is also silent, before the ratio is taken at all, when: **nothing was measured** (a failed gate,
or `baseline`, which carries no mutants); **either measurement bucket is not finite, or their sum is
0**, so there is no denominator to divide by; the report carries **no `selection`** — `probe` and
`baseline` set none, and absent is treated as unsatisfied rather than guessed; or **the fixed part of
`gatesMs` is 0** — fully cached, or only narrow-scope gate work ran, so there is nothing batching
could spread. A missed note costs nothing; a false one teaches the reader to skip the real one.

Why a ratio against *measurement* rather than a share of `totalMs`: **the ratio responds to the
remedy and the share does not.** Batching k mutants into one invocation divides the fixed cost per
unit of measurement by k; the share of `totalMs` tracks the measurement mix instead, and stays high
on a run that is already optimal. Note it is only the *fixed* part that batching leaves alone — more
narrow-eligible mutants means more narrow canary runs, so `gatesMs` itself *grows*.

On the 35-mutant catalog this harness was measured against (`npm test` ≈ 67 s). The canary's `scope`
is what decides how much of `gatesMs` is fixed, so it is the column that explains the rest:

| Run | canary `scope` | fixed part of `gatesMs` | measured | ratio |
|---|---|---|---|---|
| one mutant per invocation *(measured)* | `baseline` | 135 100 — baseline + a whole-suite canary | 2 150 | **62.8×** → fires |
| all 35 in **one** invocation *(hypothetical)* | `narrow` | ~67 500 — the baseline alone | 41 250 | **~1.6×** → silent |

The first row is a real measurement, taken **before the canary was narrowed** (card 2026-0048, earlier
in this same epic) — which is why its canary ran the whole suite and counts as fixed. Its share of
`totalMs` was 98.4%. The second row is what those 35 mutants would have cost in one invocation: a run
that narrows resolves its canary to `narrow` scope, so only the baseline stays fixed and the ratio
lands near `1.6×`. **No share of `totalMs` is quoted for it**, deliberately — that would need this
run's whole `gatesMs`, and the narrow canary half of it depends on how many distinct scopes the 35
mutants resolve to, which the field data does not record. A figure that cannot be recomputed from the
row it sits in does not belong in the row.

`10×` therefore sits ~6× above the batched run and ~6× below the per-mutant one. The batched run is
*already optimal*, and a note telling that operator to batch harder is a false alarm that costs the
note its credibility — so it is silent **twice over**, on the ratio and on the headroom conjunct,
either of which alone would hold the line. A deliberate subset run (re-confirming one fix, re-running
last round's survivors) can trip both, so the note states the numbers and makes the remedy
conditional rather than reading as a reprimand.

## The mutant catalog

Per-review, gitignored, lives at `.mutation/mutants.json`, owned by the prover. The full
per-entry field schema is specified in [`mutants.schema.md`](mutants.schema.md) — that file is the
authoritative format; this README only covers what the catalog is for.

Alongside it, `run` appends every completed verdict to a **journal** under `.mutation/journal/`, so
an interrupted run can be resumed with `run --resume` instead of re-measuring everything it already
graded. Contract — which key, what invalidates it, and the two things resume never does — is in
[`mutants.schema.md`](mutants.schema.md#resuming-a-run). Resume reuses per-mutant verdicts only; the
gates are a separate decision on a separate key ([Gate caching](#gate-caching)).

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
| **Verdict journal** (`.mutation/journal/`) | One review loop. Read only by `run --resume`. | No — gitignored, dies with the worktree. |
| **Gate cache** (`.mutation/gates/`) | One review loop. Read by every gate-running command; `--remeasure-gates` bypasses and refreshes it. | No — gitignored, dies with the worktree. |

Mutants are scaffolding: once a mutant proves a test stands, the *test* is the durable artifact and
the mutant has done its job. Keeping a catalog past merge buys little (nothing in the workspace's
practice has ever wanted a mutant after merge) and costs real upkeep, since an anchor-based mutant
is coupled to exact source text and rots on the next refactor of code nobody is currently reviewing.

## CLI — `mutate.mjs`

Stack-agnostic; the test command is always a shell string. Invoked directly, from wherever
`harness/mutation/config.json` is resolved for the current project:

```
node mutate.mjs baseline                    [--copy|--in-place] [--allow-dirty]
                                            [--remeasure-gates] [--json]
node mutate.mjs run [--id <id> ...] [--all] [--learn] [--copy|--in-place] [--jobs N]
                    [--base <branch>] [--allow-dirty] [--resume] [--remeasure-gates] [--json]
node mutate.mjs validate                    [--json]
node mutate.mjs probe --file <path> --anchor <text> --replace <text>
                      [--learn] [--expect-fail <test> ...] [--expect-pass <test> ...]
                      [--copy|--in-place] [--remeasure-gates] [--json]
node mutate.mjs probe --patch-file <path>   [--learn] [--expect-fail <test> ...]
                      [--expect-pass <test> ...] [--copy|--in-place] [--remeasure-gates] [--json]
node mutate.mjs probe --id <id>             [--copy|--in-place] [--remeasure-gates] [--json]
node mutate.mjs candidates [--base <branch>] [--json]
```

`mutate.mjs --help` is authoritative for what each flag means; this section covers what each
subcommand is *for*.

- **`baseline`** — runs the trust gates and stops. Measures `baselineCommand` in the configured
  isolation mode, records pass/fail/skip, and synthesizes a canary. Nothing else in the run is
  trustworthy until this is green and the canary comes back `KILLED`.
- **`run`** — runs one or more catalog mutants (`.mutation/mutants.json`) by `--id`, or every mutant
  with `--all`. Per mutant: resolve anchor(s)/patch → refuse an ambiguous or no-op edit → measure
  the narrow scope unmutated → apply in the isolated copy → run the narrowed `testCommand` →
  classify → restore. The only subcommand that runs the empty-diff-vs-base gate. `--learn` reports
  the failing set per mutant without grading, which is how a draft catalog gets its `expectFail`
  filled in one pass instead of guessing and paying an `IMPRECISE` re-run.
- **`validate`** — resolves every catalog site against the working tree and reports what would
  refuse, **running no tests**, so it returns in about a second instead of costing a baseline per
  stale anchor. A pre-flight, *not* a gate: it establishes nothing and emits no verdict, and exit 0
  means "the catalog resolves against this tree", never "the gates passed". Problems (a stale
  anchor, a mutant that can never read `KILLED`) exit 4; warnings never affect the exit code. The
  severity contract and per-code table are in
  [`mutants.schema.md`](mutants.schema.md#pre-flight-validation).
- **`probe`** — an ad-hoc single mutation with no catalog entry, for exploring a mutation before
  adding it to the catalog. Three mutually exclusive forms: an inline anchor swap
  (`--file`/`--anchor`/`--replace`), a unified diff read from a file (`--patch-file`, the probe form
  of the catalog's `patch` site, for structural mutations an anchor can't express), or one existing
  catalog entry re-run as authored (`--id`). The escape hatch: the clean-tree gate is a warning
  here, not a refusal. `--learn` reports the failing set for a single ad-hoc mutation without
  grading, the one-off case `run --learn` batches over a whole catalog.
- **`candidates [--base <branch>]`** — lists diff hunks (relative to `<branch>`, defaulting to
  `config.json`'s `baseBranch`) that no catalog mutant currently covers. Lists only; it never
  mutates anything — the prover picks which hunks are invariant-bearing and authors mutants for
  them via `run`/a catalog edit. Needs no harness when `--base` is given. Unlike the gate, it does
  read the whole diff, so a base far enough behind to exceed the capture limit (`GIT_MAX_BUFFER`,
  `lib/git.mjs`) is refused — the refusal names the distance and tells you to scope by hand with
  `git diff <base>...HEAD`.

**Shared flags:** `--copy` / `--in-place` override `config.json`'s `isolation` for one invocation.
`--remeasure-gates` (`baseline`/`run`/`probe`) skips the gate cache and re-measures both gates, then
overwrites the cached entry — see [Gate caching](#gate-caching). `--json` puts the
machine report on stdout instead of the printed matrix; either way `run` and `probe` always write
the same object to `.mutation/results/<runId>.json`, and refuse outright if `.mutation/` isn't
gitignored. Exit code is non-zero whenever any un-waived mutant survived — a signal a conductor can
gate on, unlike a self-reported prover verdict — and distinguishes a failed gate, a no-verdict
run, and an unconfigured project from a clean sweep; the full table is in
[`mutants.schema.md`](mutants.schema.md#exit-codes).

A scaffolded project documents how to invoke the harness for itself in its own
`harness/mutation/README.md`, written against the commands that project is actually tested with.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). Copyright © 2026 UnmanagedCode. See the [LICENSE](LICENSE) file for details.
