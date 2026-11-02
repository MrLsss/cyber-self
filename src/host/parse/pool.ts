/**
 * Bounded concurrency for work that waits on the model: PDF pages and the
 * pictures inside a document are independent of each other, and transcribing
 * them one at a time leaves the model idle between requests.
 * @module cyberself/parse/pool
 */

/** Run one worker per item with at most `limit` in flight, keeping result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const workers = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results[index] = await work(item)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()))
  return results
}
