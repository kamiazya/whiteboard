/**
 * Prefetch-behind-a-synchronous-seam, once.
 *
 * canvas-render's content seams are SYNCHRONOUS by contract while everything
 * that answers them — reading another document, importing MathJax, importing
 * mermaid — is asynchronous. Every consumer therefore has the same shape:
 * work out what this render needs, fetch what is missing, and hand the layout
 * a cache lookup.
 *
 * Written twice before this existed, and the duplicated half was not the easy
 * half. Each of the three rules below was a bug first:
 *
 * - "Nothing here" OCCUPIES its cache slot rather than being left absent.
 *   Absent means "not fetched yet", so a target that does not exist would be
 *   re-fetched on every render for the lifetime of the component. What makes
 *   it terminal is that the loop tests `cache.has`, not the value — `null`
 *   is only how a value-typed map holds "nothing here".
 * - A REJECTION is the same terminal answer BY DEFAULT, and a request that
 *   knows better says so with `attempts`. Whether asking again can help is
 *   a property of what is being fetched, not of this hook: a store read
 *   that threw is transient (one such throw left an embed on its
 *   placeholder for the life of the page — unrecoverable, and unlogged,
 *   because the throw was swallowed below this hook), while a fragment that
 *   failed to RENDER fails the same way every time and retrying it is waste
 *   per keystroke.
 * - `inflight` is what keeps a re-render from starting a second fetch for a
 *   key the first pass is still loading.
 * - Completion is scoped to UNMOUNT, never to the effect. A keystroke re-runs
 *   the effect while a load is in flight; the new pass skips that key as
 *   inflight, so cancelling the old pass's completion drops the result with
 *   nothing left to ever re-fire it. That is the stuck-placeholder bug, and
 *   it is invisible until someone types while a load is running.
 *
 * The unmount flag is reset in the effect BODY, not only at initialization:
 * StrictMode's dev double-mount runs the cleanup once before the real
 * session, and a flag that only ever goes true would silently drop every
 * completion for the component's whole life — dev-only, and invisible in a
 * production build.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * What a request asks for when its rejections are worth re-asking: three
 * attempts, because the failure it answers is a transient store read and the
 * cost of being wrong in the other direction is a permanently blank embed.
 */
export const TRANSIENT_LOAD_ATTEMPTS = 3

/** One thing to fetch, and how. The key is also the seam's lookup key. */
export interface PrefetchRequest<V> {
  readonly key: string
  /**
   * Resolves to `undefined` for "there is nothing here" — cached as terminal
   * exactly like a rejection, since both mean the same thing to a consumer.
   * A rejection is caught by this hook; a caller that wants it logged should
   * catch inside its own loader, where it has the context to say what failed.
   */
  readonly load: () => Promise<V | undefined>
  /**
   * How many times to ask when the load REJECTS. One (the default) makes a
   * rejection terminal, which is right for anything that fails the same way
   * every time; `TRANSIENT_LOAD_ATTEMPTS` is for a read that can fail once
   * and answer the next time.
   */
  readonly attempts?: number
}

/**
 * The cache itself, keyed — for a consumer that builds something over the
 * whole of what has loaded (a reference graph) rather than looking keys up
 * one at a time. `null` is the terminal "nothing here" slot described above.
 *
 * @param collect What this render needs, given everything already loaded
 *   BY KEY. The `loaded` argument is what makes a TRANSITIVE closure
 *   possible (an embedded body referencing further documents). Called
 *   inside the effect, so it must be stable — wrap it in `useCallback` over
 *   the inputs it reads.
 */
export function usePrefetchedEntries<V>(
  collect: (loaded: ReadonlyMap<string, V>) => readonly PrefetchRequest<V>[],
): ReadonlyMap<string, V | null> {
  const [cache, setCache] = useState<ReadonlyMap<string, V | null>>(new Map())
  const inflight = useRef<Set<string>>(new Set())
  const attempts = useRef<Map<string, number>>(new Map())
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])

  useEffect(() => {
    const loaded = new Map<string, V>()
    for (const [key, value] of cache) if (value !== null) loaded.set(key, value)
    for (const { key, load, attempts: allowed = 1 } of collect(loaded)) {
      if (cache.has(key) || inflight.current.has(key)) continue
      inflight.current.add(key)
      void load().then(
        (value) => {
          inflight.current.delete(key)
          if (unmounted.current) return
          setCache((prev) => new Map(prev).set(key, value ?? null))
        },
        () => {
          inflight.current.delete(key)
          if (unmounted.current) return
          const tried = (attempts.current.get(key) ?? 0) + 1
          attempts.current.set(key, tried)
          // A fresh map with the same entries: the effect keys on the cache's
          // IDENTITY, so this is what asks again without writing an answer
          // this load never gave.
          setCache((prev) => (tried >= allowed ? new Map(prev).set(key, null) : new Map(prev)))
        },
      )
    }
  }, [cache, collect])

  return cache
}

/**
 * @param collect What this render needs, given everything already loaded.
 *   The `loaded` argument is what makes a TRANSITIVE closure possible (an
 *   embedded body referencing further documents); a consumer with no such
 *   closure ignores it. Called inside the effect, so it must be stable —
 *   wrap it in `useCallback` over the inputs it reads.
 * @returns The synchronous seam: a key that has not loaded, failed, or
 *   resolved to nothing all answer `undefined`, which is what every
 *   canvas-render seam treats as "keep the documented fallback".
 */
export function usePrefetchedCache<V>(
  collect: (loaded: readonly V[]) => readonly PrefetchRequest<V>[],
): (key: string) => V | undefined {
  const cache = usePrefetchedEntries<V>(
    useCallback((loaded) => collect([...loaded.values()]), [collect]),
  )
  return useCallback((key: string) => cache.get(key) ?? undefined, [cache])
}
