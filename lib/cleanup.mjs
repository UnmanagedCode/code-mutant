// Registry of synchronous cleanup callbacks, run on normal exit and on a signal.
//
// Synchronous by contract: these run from a `process.on('exit')` handler, which
// cannot await, so anything registered here must finish without the event loop.
// That is why snapshots hold file contents in memory as Buffers rather than
// re-reading them at restore time.
//
// This module deliberately has no dependencies. `snapshot.mjs` and
// `workspace.mjs` register into it; `guard.mjs` wires it to process events.
// Keeping the registry separate from the wiring is what stops those two from
// importing each other in a cycle.

let nextId = 1;
const registered = new Map();

// `fn` must be synchronous and idempotent -- it can be called from the signal
// path and then again from the exit path.
export function registerCleanup(fn, label = 'cleanup') {
  const id = nextId++;
  registered.set(id, { fn, label });
  return id;
}

export function unregisterCleanup(id) {
  registered.delete(id);
}

export function cleanupCount() {
  return registered.size;
}

// Runs every registered callback in reverse registration order (inner-most
// first, so a snapshot inside a copy is restored before the copy is discarded)
// and collects rather than throws: one failing cleanup must not prevent the
// others from running, and the caller needs the full list to report loudly.
export function runCleanupsSync() {
  const failures = [];
  for (const [id, { fn, label }] of [...registered].reverse()) {
    registered.delete(id);
    try {
      const result = fn();
      if (Array.isArray(result)) failures.push(...result);
    } catch (err) {
      failures.push({ label, error: err?.message ?? String(err) });
    }
  }
  return failures;
}
