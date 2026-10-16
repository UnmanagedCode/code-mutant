// Canonical hashing, and the config fingerprint two independent reuse decisions
// both rest on.
//
// The verdict journal (lib/journal.mjs) and the gate cache (lib/gate-cache.mjs)
// each answer "is what was recorded applicable to THIS invocation?", and both
// answer partly from the resolved config. Two copies of that answer could drift
// into disagreeing about what a config change is -- one reusing across an edit
// the other treats as invalidating -- so there is one.

import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Canonical JSON: keys sorted at every level, so two objects that differ only in
// key order hash the same. Without this a fingerprint would change when a
// reviewer reorders fields in the catalog, forcing a needless re-run.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// EVERYTHING IN THE RESOLVED CONFIG THAT CHANGES WHAT A MEASURED COMMAND DOES,
// and deliberately nothing else. `repoRoot`, `configPath`, `configDir`, `jobs`
// and `baseBranch` are excluded: none of them changes what a command measures.
//
// A canonical STRING rather than a digest, because it is embedded in a larger
// canonical object by both callers -- hashing it here would only hide it.
//
// `routes` joins the fingerprint ONLY when present, so a single-runner config's
// string -- and with it every existing journal key and gate-cache key -- is
// byte-for-byte what it was before routing existed.
export function configFingerprint(config) {
  return canonical({
    baselineCommand: config.baselineCommand,
    testCommand: config.testCommand,
    runner: config.runner,
    timeoutMs: config.timeoutMs,
    hang: config.hang,
    setup: config.setup,
    teardown: config.teardown,
    preserve: config.preserve,
    ...(config.routes ? { routes: config.routes } : {}),
  });
}
