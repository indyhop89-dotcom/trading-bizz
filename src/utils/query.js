// Small helper to bound how long we'll wait on a Supabase query before giving
// the user a clear error instead of an indefinite spinner. Supabase query
// builders are thenables, so Promise.race works directly on them.
//
// This does NOT cancel the underlying request (PostgREST has no client-side
// cancel), it just stops the UI from waiting forever — the user gets a usable
// error and can retry rather than staring at a frozen "Loading…".
export function withTimeout(promise, ms = 20000, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — the server did not respond. Check your connection and try again.`)), ms)
    ),
  ])
}
