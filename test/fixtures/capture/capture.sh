#!/usr/bin/env bash
# Re-captures the adapter fixtures under test/fixtures/<adapter>/ from REAL tool runs.
#
# The fixtures are committed, so the test suite itself never needs network or a
# toolchain. This script exists so their provenance is reproducible rather than
# asserted. Run it when an adapter is added or a tool's output format changes:
#
#   RUN_REAL_CAPTURE=1 bash test/fixtures/capture/capture.sh [adapter ...]
#
# Naming adapters (node-test, pytest, vitest, dotnet) re-captures only those;
# with none, every adapter is re-captured. Needs network (pip / NuGet), a dotnet
# SDK, and for vitest this repo's own pinned devDependency (`npm ci` first).
# Whatever it cannot capture is reported and left alone -- never replaced with a
# hand-written sample. An adapter
# whose parser was never proven against real output would contradict the premise of
# this tool, which exists to stop unverified green claims.
set -uo pipefail

if [ "${RUN_REAL_CAPTURE:-}" != "1" ]; then
  echo "capture.sh: skipped (set RUN_REAL_CAPTURE=1 to re-capture from real toolchains)"
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$(cd "$HERE/.." && pwd)"
WORK="${CAPTURE_WORKDIR:-/tmp/code-mutant-capture}"
rm -rf "$WORK" && mkdir -p "$WORK"

SKIPPED=()

# capture <adapter> <case> <tool> <version> <cwd> -- <cmd...>
capture() {
  local adapter=$1 case=$2 tool=$3 version=$4 dir=$5; shift 6   # shift past the literal --
  local out="$FIX/$adapter"
  mkdir -p "$out"
  # Every command gets a fresh, empty report dir in $CODE_MUTANT_REPORT_DIR, as
  # lib/reports.mjs gives it under the runner; whatever it writes there is kept
  # beside the streams as <case>.report.<basename> and named in the meta.
  local reports="$WORK/reports/$adapter-$case"
  rm -rf "$reports" && mkdir -p "$reports"
  rm -f "$out/$case.report."*
  ( cd "$dir" && CODE_MUTANT_REPORT_DIR="$reports" "$@" ) >"$out/$case.stdout.txt" 2>"$out/$case.stderr.txt"
  local rc=$?
  local cmd="$*"
  local names=() f b
  for f in "$reports"/*; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"
    cp "$f" "$out/$case.report.$b"
    names+=("\"$b\"")
  done
  local joined; joined="$(IFS=,; echo "${names[*]}")"
  cat >"$out/$case.meta.json" <<EOF
{
  "tool": "$tool",
  "version": "$version",
  "command": "${cmd//\"/\\\"}",
  "cwd": "$dir",
  "exitCode": $rc,
  "reports": [$joined],
  "capturedBy": "test/fixtures/capture/capture.sh"
}
EOF
  echo "  captured $adapter/$case (exit $rc)"
}

# ---------------------------------------------------------------- node --test
capture_node_test() {
  echo "node-test:"
  local v; v="$(node --version)"
  local d="$WORK/node"; mkdir -p "$d/test"

  cat >"$d/test/math.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('adds', () => { assert.equal(1 + 1, 2); });
test('subtracts', () => { assert.equal(2 - 1, 1); });
EOF
  capture node-test pass node "$v" "$d" -- node --test

  cat >"$d/test/math.test.mjs" <<'EOF'
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

test('adds', () => { assert.equal(1 + 1, 2); });
test('subtracts', () => { assert.equal(2 - 1, 99); });
describe('nested', () => {
  test('inner failure', () => { assert.ok(false); });
});
EOF
  capture node-test fail node "$v" "$d" -- node --test

  cat >"$d/test/math.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('adds', () => { assert.equal(1 + 1, 2); });
test('skipped for a reason', { skip: 'not implemented' }, () => {});
test('todo item', { todo: true }, () => {});
EOF
  capture node-test skip node "$v" "$d" -- node --test

  cat >"$d/test/math.test.mjs" <<'EOF'
import { test } from 'node:test';
this is not valid javascript (
EOF
  capture node-test compile-error node "$v" "$d" -- node --test
}

# -------------------------------------------------------------------- pytest
capture_pytest() {
  echo "pytest:"
  local d="$WORK/py"; mkdir -p "$d/tests"
  python3 -m venv "$d/venv" >/dev/null 2>&1
  local py="$d/venv/bin/python3"
  if [ ! -x "$py" ]; then SKIPPED+=("pytest: python3 -m venv failed"); return; fi
  if ! "$py" -m pip --version >/dev/null 2>&1; then
    curl -sS -o "$d/get-pip.py" https://bootstrap.pypa.io/get-pip.py >/dev/null 2>&1
    "$py" "$d/get-pip.py" -q >/dev/null 2>&1
  fi
  if ! "$py" -m pip install -q pytest >/dev/null 2>&1; then
    SKIPPED+=("pytest: pip install pytest failed (network?)"); return
  fi
  local v; v="$("$py" -m pytest --version 2>&1 | head -1)"

  cat >"$d/tests/test_math.py" <<'EOF'
def test_adds():
    assert 1 + 1 == 2


def test_subtracts():
    assert 2 - 1 == 1
EOF
  capture pytest pass pytest "$v" "$d" -- "$py" -m pytest

  cat >"$d/tests/test_math.py" <<'EOF'
def test_adds():
    assert 1 + 1 == 2


def test_subtracts():
    assert 2 - 1 == 99


class TestGroup:
    def test_inner(self):
        raise ValueError("boom")
EOF
  capture pytest fail pytest "$v" "$d" -- "$py" -m pytest

  cat >"$d/tests/test_math.py" <<'EOF'
import pytest


def test_adds():
    assert 1 + 1 == 2


@pytest.mark.skip(reason="not implemented")
def test_skipped():
    pass


@pytest.mark.xfail
def test_expected_failure():
    assert False
EOF
  capture pytest skip pytest "$v" "$d" -- "$py" -m pytest

  cat >"$d/tests/test_math.py" <<'EOF'
def test_adds(:
    assert 1 + 1 == 2
EOF
  capture pytest compile-error pytest "$v" "$d" -- "$py" -m pytest
}

# -------------------------------------------------------------------- vitest
# Uses THIS repo's pinned devDependency (package.json), never a fresh `npm i`, so
# the fixtures come from the exact Vitest the suite's end-to-end tests drive.
# Every case writes the JSON report into the report dir -- the only output the
# adapter reads -- through the same shell a harness command runs under.
capture_vitest() {
  echo "vitest:"
  local repo; repo="$(cd "$FIX/../.." && pwd)"
  local entry="$repo/node_modules/vitest/vitest.mjs"
  if [ ! -f "$entry" ]; then SKIPPED+=("vitest: $entry missing -- run npm ci first"); return; fi
  local d="$WORK/vt"; mkdir -p "$d/test"
  printf '{"name":"vt-fixture","private":true,"type":"module"}\n' >"$d/package.json"
  ln -s "$repo/node_modules" "$d/node_modules"
  local v; v="$(node "$entry" --version 2>&1 | head -1)"
  local vt='node node_modules/vitest/vitest.mjs run --reporter=json --outputFile="$CODE_MUTANT_REPORT_DIR/vitest.json"'

  cat >"$d/test/math.test.js" <<'EOF'
import { test, expect } from 'vitest';

test('adds', () => { expect(1 + 1).toBe(2); });
test('subtracts', () => { expect(2 - 1).toBe(1); });
EOF
  capture vitest pass vitest "$v" "$d" -- sh -c "$vt"

  cat >"$d/test/math.test.js" <<'EOF'
import { test, describe, expect } from 'vitest';

test('adds', () => { expect(1 + 1).toBe(2); });
test('subtracts', () => { expect(2 - 1).toBe(99); });
describe('nested', () => {
  test('inner failure', () => { throw new Error('boom'); });
});
EOF
  capture vitest fail vitest "$v" "$d" -- sh -c "$vt"

  cat >"$d/test/math.test.js" <<'EOF'
import { test, expect } from 'vitest';

test('adds', () => { expect(1 + 1).toBe(2); });
test.skip('skipped for a reason', () => {});
test.todo('todo item');
EOF
  capture vitest skip vitest "$v" "$d" -- sh -c "$vt"

  # A file that fails to transform, beside one that passes: the load failure
  # must surface without hiding the passing file's counts.
  cat >"$d/test/math.test.js" <<'EOF'
import { test, expect } from 'vitest';

test('adds', () => { expect(1 + 1).toBe(2); });
EOF
  cat >"$d/test/broken.test.js" <<'EOF'
import { test } from 'vitest';
this is not valid javascript (
EOF
  capture vitest compile-error vitest "$v" "$d" -- sh -c "$vt"
  rm "$d/test/broken.test.js"

  # Test-emitted stdout around the report: console output, a raw write with no
  # trailing newline at module scope and in a test, and a decoy report prefix.
  cat >"$d/test/math.test.js" <<'EOF'
import { test, describe, expect } from 'vitest';

console.log('module-scope console.log');
console.error('module-scope console.error');
process.stdout.write('module-scope-no-newline');

test('adds', () => {
  console.log('in-test console.log');
  process.stdout.write('in-test-no-newline');
  expect(1 + 1).toBe(2);
});
test('decoy', () => {
  process.stdout.write('{"numTotalTestSuites":1}');
  expect(true).toBe(true);
});
describe('nested', () => {
  test('inner failure', () => { throw new Error('boom'); });
});
EOF
  capture vitest console-noise vitest "$v" "$d" -- sh -c "$vt"

  # A report far larger than a pipe buffer (64 KiB): 2000 tests with long
  # titles, exactly one failing.
  cat >"$d/test/math.test.js" <<'EOF'
import { test, expect } from 'vitest';

const pad = 'x'.repeat(110);
for (let i = 0; i < 2000; i += 1) {
  test(`generated ${String(i).padStart(4, '0')} ${pad}`, () => { expect(i < 0).toBe(false); });
}
test('the one failure', () => { expect(1).toBe(2); });
EOF
  capture vitest large vitest "$v" "$d" -- sh -c "$vt"

  # A file filter matching no file: Vitest exits 1 with an empty report.
  cat >"$d/test/math.test.js" <<'EOF'
import { test, expect } from 'vitest';

test('adds', () => { expect(1 + 1).toBe(2); });
EOF
  capture vitest no-files vitest "$v" "$d" -- sh -c "$vt test/no-such-file.test.js"

  # An error thrown outside any test after it passed: every test passes and
  # Vitest still exits 1.
  cat >"$d/test/math.test.js" <<'EOF'
import { test, expect } from 'vitest';

test('adds', () => {
  setTimeout(() => { throw new Error('thrown after the test passed'); }, 0);
  expect(1 + 1).toBe(2);
});
test('waits', async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
EOF
  capture vitest unhandled-error vitest "$v" "$d" -- sh -c "$vt"
}

# -------------------------------------------------------------------- dotnet
capture_dotnet() {
  echo "dotnet:"
  command -v dotnet >/dev/null 2>&1 || { SKIPPED+=("dotnet: no dotnet SDK on PATH"); return; }
  local v; v="$(dotnet --version)"
  local d="$WORK/dn"; mkdir -p "$d"
  if ! ( cd "$d" && dotnet new xunit -o proj >/dev/null 2>&1 ); then
    SKIPPED+=("dotnet: dotnet new xunit failed (NuGet?)"); return
  fi
  local p="$d/proj"

  cat >"$p/UnitTest1.cs" <<'EOF'
namespace proj;

public class UnitTest1
{
    [Fact]
    public void Adds() => Assert.Equal(2, 1 + 1);

    [Fact]
    public void Subtracts() => Assert.Equal(1, 2 - 1);
}
EOF
  capture dotnet pass dotnet "$v" "$p" -- dotnet test

  cat >"$p/UnitTest1.cs" <<'EOF'
namespace proj;

public class UnitTest1
{
    [Fact]
    public void Adds() => Assert.Equal(2, 1 + 1);

    [Fact]
    public void Subtracts() => Assert.Equal(99, 2 - 1);

    [Fact]
    public void Throws() => throw new InvalidOperationException("boom");
}
EOF
  capture dotnet fail dotnet "$v" "$p" -- dotnet test

  cat >"$p/UnitTest1.cs" <<'EOF'
namespace proj;

public class UnitTest1
{
    [Fact]
    public void Adds() => Assert.Equal(2, 1 + 1);

    [Fact(Skip = "not implemented")]
    public void Skipped() { }
}
EOF
  capture dotnet skip dotnet "$v" "$p" -- dotnet test

  cat >"$p/UnitTest1.cs" <<'EOF'
namespace proj;

public class UnitTest1
{
    [Fact]
    public void Adds() => Assert.Equal(2, 1 + ;
}
EOF
  capture dotnet compile-error dotnet "$v" "$p" -- dotnet test
}

SECTIONS=("$@")
[ ${#SECTIONS[@]} -eq 0 ] && SECTIONS=(node-test pytest vitest dotnet)
for section in "${SECTIONS[@]}"; do
  case "$section" in
    node-test) capture_node_test ;;
    pytest) capture_pytest ;;
    vitest) capture_vitest ;;
    dotnet) capture_dotnet ;;
    *) echo "capture.sh: unknown adapter $section" >&2; exit 2 ;;
  esac
done

echo
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "NOT CAPTURED (fixtures left untouched -- report these as gaps, do not hand-write them):"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
  exit 1
fi
echo "captured from real runs: ${SECTIONS[*]}"
