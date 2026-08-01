// `dotnet test` (VSTest console). Pinned to captured output in test/fixtures/dotnet/.
//
// Counts come from the one-line result banner:
//   `Failed!  - Failed:     2, Passed:     1, Skipped:     0, Total:     3, ...`
// Failed ids come from `  Failed <FullyQualifiedName> [9 ms]` lines.
//
// THE FILE-GRANULARITY WRINKLE: dotnet's output carries no file path at all, so
// this adapter's default narrowing unit is the DECLARING TYPE (`proj.UnitTest1`)
// rather than a file. That is the honest analogue of "the test file" -- it still
// runs sibling tests the reviewer did not name, which is what keeps IMPRECISE
// detectable. A test reference here is therefore a fully-qualified name, not a
// `file::name` pair.
//
// A build failure prints `... error CS1525: ...` and no result banner at all;
// that is the compile-error signal.

import {
  CANARY_LABEL, CANARY_MESSAGE, countedResult, lastMatch, shellQuote, stripAnsi,
} from './common.mjs';

export const name = 'dotnet';
export const grade = 'counted';
export const canNameFilter = true;
export const testFilePatterns = ['**/*Test*.cs', '**/*Tests*.cs', '**/*Spec*.cs'];

export function parse(stdout, stderr, exitCode) {
  const out = stripAnsi(stdout);
  const err = stripAnsi(stderr);
  const all = `${out}\n${err}`;

  const banner = lastMatch(
    out,
    /^(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/gm,
  );

  const failed = banner ? Number(banner[1]) : 0;
  const passed = banner ? Number(banner[2]) : 0;
  const skipped = banner ? Number(banner[3]) : 0;
  const ran = banner ? Number(banner[4]) : 0;

  const failedTests = [];
  for (const [, fqn] of out.matchAll(/^\s*Failed\s+(\S+)\s+\[/gm)) {
    failedTests.push({ file: null, name: fqn, id: fqn });
  }
  if (!failedTests.length) {
    // Fallback: the xUnit adapter also announces failures on stderr.
    for (const [, fqn] of err.matchAll(/^\[xUnit\.net[^\]]*\]\s+(\S+)\s+\[FAIL\]/gm)) {
      failedTests.push({ file: null, name: fqn, id: fqn });
    }
  }

  const buildError = /\berror\s+[A-Z]{2}\d+:/.test(all) || /^MSBUILD\s*:\s*error/m.test(all);
  // No banner at all with a non-zero exit means the run never got as far as
  // executing tests -- a build or harness break, not a coverage signal.
  const compileError = buildError || (!banner && exitCode !== 0);

  return countedResult({
    passed, failed, skipped, ran, failedTests, compileError,
    counts: { exitCode, sawBanner: Boolean(banner) },
  });
}

// The declaring type: everything before the final dot of the FQN.
export function scopeOf(ref) {
  const text = String(ref);
  const at = text.lastIndexOf('.');
  return at === -1 ? text : text.slice(0, at);
}

export function substitute({ scopes, refs, mode }) {
  const expression = mode === 'names'
    ? refs.map((r) => `FullyQualifiedName=${r}`).join('|')
    : scopes.map((s) => `FullyQualifiedName~${s}`).join('|');
  return `--filter ${shellQuote(expression)}`;
}

// Appends a new test class. Its namespace depends on whether the target file uses
// a file-scoped or block-scoped namespace, so the expected FQN is not predictable
// -- hence the suffix match rather than an exact id.
export function canary(source, { file }) {
  const className = 'CodeMutantCanary';
  const method = `${CANARY_LABEL}_fires`;
  const content = `${source}${source.endsWith('\n') ? '' : '\n'}
public class ${className}
{
    [Fact]
    public void ${method}() => throw new System.InvalidOperationException(${JSON.stringify(CANARY_MESSAGE)});
}
`;
  return {
    content,
    testId: `${className}.${method}`,
    matches: (failure) => failure.name.endsWith(`${className}.${method}`),
  };
}
