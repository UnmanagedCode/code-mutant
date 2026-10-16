# Adapter fixture provenance

Every file here is **captured from a real toolchain run**, not hand-written. Parsers are the one
place project-facing behaviour is inferred from text, so they are pinned to real samples: an adapter
whose parser was never proven against real output would contradict the premise of a tool that exists
to stop unverified green claims.

Regenerate with:

```
RUN_REAL_CAPTURE=1 bash test/fixtures/capture/capture.sh
```

That script needs network (pip / npm / NuGet) and a dotnet SDK. Anything it cannot capture it reports
and leaves alone rather than substituting a written sample.

## Layout

Per adapter, per case: `<case>.stdout.txt`, `<case>.stderr.txt`, `<case>.meta.json`. The meta file
records the tool, its version, the exact command, the real exit code — `parse()` takes the exit
code as an argument, so the fixture would be incomplete without it — and, for captures made by the
current script, `cwd`: the directory the command ran in. A runner that reports absolute paths
(vitest) is parsed with `{ cwd }` as its `context`, exactly as the runner passes the workspace root.
Streams are kept separate because runners differ in which one carries results; every adapter here
reads stdout (vitest's JSON report included).

The script captures stdout through a **pipe**, as `lib/exec.mjs` gives every project command — never
a file, which a runner writing its report to `/dev/stdout` would truncate. Pass adapter names to
re-capture only those: `RUN_REAL_CAPTURE=1 bash test/fixtures/capture/capture.sh vitest`.

## Captured

| Adapter | Tool version | Cases |
|---|---|---|
| `node-test` | node v24.18.0 (spec reporter) | pass, fail (incl. a nested `describe` failure), skip (incl. `todo`), compile-error (module-level `SyntaxError`) |
| `pytest` | pytest 9.1.1 / Python 3.13.5 | pass, fail (incl. a class-scoped test), skip (incl. `xfail`), compile-error (collection error) |
| `vitest` | vitest 5.0.5 (this repo's pinned devDependency), `run --reporter=json --outputFile=/dev/stdout` | pass, fail (incl. nested `describe`), skip (incl. `todo`), compile-error (a transform failure beside a passing file), console-noise (`console.*`, raw no-newline writes at module scope and in a test, a decoy `{"numTotalTestSuites":1}`), large (2001 tests, report > 64 KiB), no-files (a filter matching nothing, exit 1), unhandled-error (every test passes, exit 1) |
| `dotnet` | dotnet 8.0.423 / VSTest 17.11.1 / xUnit | pass, fail (assertion + thrown exception), skip (`[Fact(Skip=…)]`), compile-error (`error CS1525`) |

Measured Vitest 5.0.5 behaviour the adapter rests on (`lib/adapters/vitest.mjs`):

- The JSON report is one line with no trailing newline, written at run end and followed on stdout
  by `JSON report written to /dev/stdout`. Without `--outputFile` it goes to
  `<root>/.vitest/json/output.json` instead.
- `console.*` from a test is not printed under the JSON reporter; a raw `process.stdout.write`
  is, before the report. stderr is empty in every captured case.
- `testResults[].name` is absolute. A file that never produced a test has `status: "failed"`, a
  non-empty `message` and no `assertionResults`.
- `-t` is matched against `fullTestName`, joined with ` > `: `-t '^nested > deeper > inner failure$'`
  runs exactly that nested test, and the space-joined `fullName` form selects nothing.

Each case deliberately contains a *nested* or *grouped* test in its failure sample, because the
nesting is what determines the test-reference format a reviewer has to write — see the reference
table in `mutants.schema.md`.

## Not captured

**`cargo`** — no cargo adapter ships. A Rust project uses the project-local `custom` `parse.mjs`
escape hatch. No cargo toolchain was available to capture real output from, and hand-writing a
fixture from the documented libtest format would have produced exactly the unproven parser this
project exists to prevent.
