// The narrowing policy: what `{tests}` becomes.
//
// This is NOT a per-project free choice. Granularity decides whether a mutant
// reads IMPRECISE or KILLED, so letting each scaffold interpret `{tests}` would
// break the uniform verdict semantics the whole design rests on.
//
// THE POLICY: substitute the smallest scope that both (i) includes every
// expectFail ∪ expectPass test and (ii) still lets the adapter observe failures
// OUTSIDE expectFail within that scope. In practice: file granularity (for dotnet,
// the declaring type -- see that adapter).
//
// Name-level narrowing is the tempting default and it is wrong as a default:
// running exactly expectFail ∪ expectPass makes "a failure outside expectFail"
// unobservable by construction, which silently guts IMPRECISE -- the verdict that
// catches equivalent mutants. Condition (ii) exists to stop the narrowing from
// destroying the precision the narrowing is meant to serve.
//
// A reviewer CAN opt a single mutant into name-level narrowing with
// `narrowTo: "names"`, which is how the policy's "the file holds tests the
// reviewer deliberately excludes" case gets expressed -- the runner cannot detect
// deliberate exclusion, only the author can state it. When that happens, IMPRECISE
// detection shrinks to the expectPass set alone, so the report labels the mutant's
// narrowing mode next to its verdict.

export const NarrowMode = {
  COMMAND: 'command',
  WHOLE: 'whole',
  FILE: 'file',
  NAMES: 'names',
};

export const PLACEHOLDER = '{tests}';

function substituteInto(template, value) {
  if (!template.includes(PLACEHOLDER)) return { command: template, placeholder: false };
  return {
    command: template.split(PLACEHOLDER).join(value).replace(/\s{2,}/g, ' ').trim(),
    placeholder: true,
  };
}

export function planNarrowing({ mutant, adapter, testCommand }) {
  const refs = [...new Set([...(mutant.expectFail ?? []), ...(mutant.expectPass ?? [])])];

  // A per-mutant narrowCommand wins outright, and is the documented way to scope
  // an exit-code gate.
  if (typeof mutant.narrowCommand === 'string' && mutant.narrowCommand.trim()) {
    return {
      command: mutant.narrowCommand.trim(),
      mode: NarrowMode.COMMAND,
      scopes: [],
      refs,
      placeholder: false,
      requestedNames: mutant.narrowTo === 'names',
      downgradeReason: null,
    };
  }

  // Exit-code grade: nothing to filter, so the whole gate command runs.
  if (adapter.grade === 'exit-code') {
    const { command, placeholder } = substituteInto(testCommand, '');
    return {
      command,
      mode: NarrowMode.WHOLE,
      scopes: [],
      refs,
      placeholder,
      requestedNames: mutant.narrowTo === 'names',
      downgradeReason: mutant.narrowTo === 'names' ? 'exit-code grade cannot filter by test name' : null,
    };
  }

  const scopes = [...new Set(refs.map((ref) => adapter.scopeOf(ref)).filter(Boolean))].sort();
  if (!scopes.length) {
    throw new Error(
      `mutant ${mutant.id}: cannot narrow without at least one entry in expectFail or expectPass `
      + '(counted mode needs to know which scope to run)',
    );
  }

  const wantsNames = mutant.narrowTo === 'names';
  let mode = NarrowMode.FILE;
  let downgradeReason = null;

  if (wantsNames) {
    const named = refs.filter((ref) => {
      const scope = adapter.scopeOf(ref);
      return scope !== ref; // the ref carries more than just its scope
    });
    if (!adapter.canNameFilter) {
      downgradeReason = `the ${adapter.name} adapter cannot filter by test name`;
    } else if (!named.length) {
      downgradeReason = 'no expectFail/expectPass entry names an individual test';
    } else {
      mode = NarrowMode.NAMES;
    }
  }

  const { command, placeholder } = substituteInto(
    testCommand,
    adapter.substitute({ scopes, refs, mode }),
  );

  return { command, mode, scopes, refs, placeholder, requestedNames: wantsNames, downgradeReason };
}
