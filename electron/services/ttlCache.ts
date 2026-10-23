/**
 * Wraps an async lookup so it runs at most once per TTL window. The result is
 * kept even when it is a failure (a `null` or a rejection), so an outage is not
 * retried on every call, and callers that overlap share one in-flight request.
 *
 * @param fetch - The lookup to cache.
 * @param ttlMs - How long a result is kept, counted from the call that started it.
 * @param now - Clock in milliseconds; replaceable for tests.
 * @returns A function that returns the cached or freshly started lookup.
 */
export function ttlCached<T>(fetch: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T>
{
  let cached: { at: number; result: Promise<T> } | undefined
  return () =>
  {
    const t = now()
    if (!cached || t - cached.at >= ttlMs) cached = { at: t, result: fetch() }
    return cached.result
  }
}
