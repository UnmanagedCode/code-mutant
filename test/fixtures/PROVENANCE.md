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
records the tool, its version, the exact command, and the real exit code — `parse()` takes the exit
code as an argument, so the fixture would be incomplete without it. Streams are kept separate
because some runners report failures on stderr (vitest) and others on stdout (node, pytest, dotnet).

## Captured

| Adapter | Tool version | Cases |
|---|---|---|
| `node-test` | node v24.18.0 (spec reporter) | pass, fail (incl. a nested `describe` failure), skip (incl. `todo`), compile-error (module-level `SyntaxError`) |
| `pytest` | pytest 9.1.1 / Python 3.13.5 | pass, fail (incl. a class-scoped test), skip (incl. `xfail`), compile-error (collection error) |
| `vitest` | vitest 4.1.10 | pass, fail (incl. nested `describe`), skip (incl. `todo`), compile-error (vite transform failure → `Failed Suites`) |
| `dotnet` | dotnet 8.0.423 / VSTest 17.11.1 / xUnit | pass, fail (assertion + thrown exception), skip (`[Fact(Skip=…)]`), compile-error (`error CS1525`) |

Each case deliberately contains a *nested* or *grouped* test in its failure sample, because the
nesting is what determines the test-reference format a reviewer has to write — see the reference
table in `mutants.schema.md`.

## Not captured

**`cargo`** — no cargo adapter ships. A Rust project uses the project-local `custom` `parse.mjs`
escape hatch. No cargo toolchain was available to capture real output from, and hand-writing a
fixture from the documented libtest format would have produced exactly the unproven parser this
project exists to prevent.
