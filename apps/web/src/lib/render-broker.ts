/**
 * The one seam every surface asks for a picture through (ADR-0027 decision 1).
 *
 * The broker owns DECISIONS — what is already drawn, what is being drawn right
 * now, and who joins whom. It owns no pipeline: the caller passes the producer
 * for its own kind, and the worker pool stays exactly where it was. That is
 * what makes this additive rather than a rewrite, and it is what lets a
 * SharedWorker or a daemon become another implementation of this port instead
 * of a second path through the app.
 *
 * Why a producer per call is sound rather than sloppy: the key fully
 * determines the bytes. `renderSceneToSvg` is pinned byte-for-byte against the
 * same committed golden string in the node and browser projects, so two
 * producers for one key are interchangeable by construction. The same fact is
 * what will make two tabs racing to fill one persistent entry harmless.
 */

import { isMemoisableKey, type RenderKey, renderKeyPath } from './render-key.js'

/** What a surface gets back. `null` is "nothing to draw", and it is an answer. */
export interface RenderResult {
  readonly svg: string
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

export interface RenderBroker {
  /**
   * The picture for `key`. `produce` runs at most once per key: a caller that
   * arrives while the same key is still in flight joins it rather than
   * starting a second render.
   */
  render(key: RenderKey, produce: () => Promise<RenderResult | null>): Promise<RenderResult | null>
  /** Entries currently held. For tests and for the cap below. */
  readonly size: number
}

/**
 * A memory backstop, not an eviction policy. A list touches every visible key
 * on each pass, so by the time the cap trips the map is dominated by keys from
 * documents nobody is looking at any more; dropping the oldest costs one
 * re-render of something a scroll would rebuild anyway.
 */
const DEFAULT_MAX_ENTRIES = 200

export interface InTabRenderBrokerOptions {
  readonly maxEntries?: number
}

export function createInTabRenderBroker(options: InTabRenderBrokerOptions = {}): RenderBroker {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  // Insertion-ordered, so the oldest key is the first one `keys()` yields.
  const done = new Map<string, RenderResult | null>()
  // Separate from `done` because an in-flight entry is not an answer yet, and
  // a rejection must leave nothing behind — a row whose fetch failed once must
  // not keep its kind icon for the rest of the session.
  const inFlight = new Map<string, Promise<RenderResult | null>>()

  return {
    get size() {
      return done.size
    },
    render(key, produce) {
      const path = renderKeyPath(key)
      if (done.has(path)) return Promise.resolve(done.get(path) ?? null)

      const joined = inFlight.get(path)
      if (joined !== undefined) return joined

      const work = produce()
        .then((result) => {
          // A key that cannot notice its document changing must not remember
          // an answer: it would serve the old picture for as long as the tab
          // is open. Joining the in-flight work above is still right there —
          // the callers are asking in the same instant, about the same bytes.
          if (!isMemoisableKey(key)) return result
          if (done.size >= maxEntries) {
            const oldest = done.keys().next()
            if (oldest.done !== true) done.delete(oldest.value)
          }
          done.set(path, result)
          return result
        })
        .finally(() => {
          inFlight.delete(path)
        })
      inFlight.set(path, work)
      return work
    },
  }
}
