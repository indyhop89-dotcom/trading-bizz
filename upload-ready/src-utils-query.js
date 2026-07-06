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

// PostgREST caps a single response at 1000 rows by default. Any table that
// can realistically grow past that (products, opening stock, etc.) needs to
// page through with .range() or it silently truncates — the query looks like
// it succeeded, it just quietly drops everything past row 1000. Pass a
// builder-factory (not a built query) so each page can set its own .range().
export async function fetchAllPages(buildQuery, pageSize = 1000) {
  const all = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return { data: all, error: null }
}
