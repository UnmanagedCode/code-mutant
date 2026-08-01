// Polls a predicate instead of sleeping, so the signal tests are deterministic
// and fast: they wait for the exact state they need and fail with a message
// naming what never happened, rather than waiting out a fixed delay.

export async function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 10, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let result;
    try { result = await predicate(); } catch { result = false; }
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}
