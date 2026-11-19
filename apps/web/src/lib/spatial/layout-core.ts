import type { LayoutCore, LayoutRefusal } from '@kamiazya/whiteboard-canvas-render'
// Types only: this module is on the page's critical path, and a value import
// of codec would carry its readers (the schemas) into the boot bundle.
// Installing the OKF and JSON Canvas cores into codec is `codec-cores.ts`'s,
// which only the call sites that read or write them import.
import { isCoreTrap } from '../core-trap.js'
import type { WebCore } from './web-core.js'

/**
 * The Rust core as this realm holds it (ADR-0054): the page and the layout
 * worker each build their own, since a wasm instance is not shared across
 * realms. Every layout, note and query this app makes is answered by it, and
 * there is no TypeScript to answer in its place (S18g), so each realm awaits
 * `ready` before its first layout: the page at boot (`boot.ts`), the worker
 * before its first message. `current` is synchronous because the layouts
 * that ask (a drag frame, a render) cannot wait.
 */
export interface LayoutCoreHost {
  /** Starts the load on first call; settles with the core, or rejects when it cannot load. */
  ready(): Promise<LayoutCore>
  /**
   * The loaded core; `undefined` only before the load settles, which a realm
   * that awaited `ready` never sees. After a failed load it answers a core
   * that refuses every layout as `core-unavailable`, which each surface draws
   * as its refusal notice, and starts one more load once `retryAfterMs` has
   * passed since the last failure. The first failure also schedules one
   * retry at that delay by itself.
   */
  current(): LayoutCore | undefined
  /** How many times a core became available; a surface keyed on it draws again when it does. */
  generation(): number
  /** Calls `listener` whenever `generation` moves. Answers the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * Starts the load on first call and settles with the core the OKF and JSON
   * Canvas codecs answer through: a load that fails rejects (and the next call
   * tries again).
   */
  codecs(): Promise<WebCore>
}

/**
 * What a realm does with a call that trapped the instance: `refuse` draws it
 * as the notice (the page, which must draw whatever happens), `throw` leaves it
 * to the caller (the layout worker, which answers the request as a failure the
 * asking thread redraws, and must learn when the instance cannot be reset).
 */
export type TrapPolicy = 'refuse' | 'throw'

/** What a layout draws when the call trapped the core's wasm instance. */
const CORE_TRAPPED: LayoutRefusal = { code: 'malformed', reason: 'core-trapped' }

/**
 * `call`, or the refusal for the one call that trapped the instance: the shim
 * has already reset it, so the next call is answered, and a surface draws this
 * draw's refusal as its notice instead of throwing out of a render. Anything
 * else it throws is a defect and propagates.
 */
function refusingTraps<A extends unknown[], R>(
  call: (...args: A) => R,
): (...args: A) => R | { readonly refused: LayoutRefusal } {
  return (...args) => {
    try {
      return call(...args)
    } catch (err) {
      if (isCoreTrap(err)) return { refused: CORE_TRAPPED }
      throw err
    }
  }
}

/**
 * What one loaded instance answers: every layout entry, through the one
 * instance. Routing has no refusal arm, so its trap is thrown and its one
 * caller (the connect preview) draws no line for that frame.
 */
const layoutFrom = (core: WebCore, traps: TrapPolicy): LayoutCore =>
  traps === 'throw'
    ? { routing: core, layout: core, markdown: core, query: core }
    : {
        routing: core,
        layout: {
          layoutSpatialCanvas: refusingTraps((...args) => core.layoutSpatialCanvas(...args)),
        },
        markdown: { layoutMarkdown: refusingTraps((...args) => core.layoutMarkdown(...args)) },
        query: { layoutQuery: refusingTraps((...args) => core.layoutQuery(...args)) },
      }

/** A load that had not settled within its bound, abandoned and its fetch aborted. */
class CoreLoadTimedOut extends Error {
  override readonly name = 'CoreLoadTimedOut'
  constructor(readonly timeoutMs: number) {
    super(`the Rust core did not load within ${timeoutMs} ms`)
  }
}

/**
 * How long a load may take before it is abandoned. Sized from the artifact:
 * the shipped wasm is 1,647,795 bytes, 606,011 gzipped (brotli is smaller,
 * gzip is the worse case a host may serve), and Chrome's slowest throttling
 * preset (Slow 3G: 400 kbit/s, 2 s round trip) moves that in about 12 s, about
 * 14 s with the connection's setup; compiling it took 4-6 ms in Node. Twice
 * that, so a slow but live connection loads while a fetch that never settles
 * (a captive portal, a held request) stops holding the boot splash.
 */
const CORE_LOAD_TIMEOUT_MS = 30_000

/**
 * How long after a failed load a layout asks for the core again: one load
 * at a time, at most this often, however many frames ask, so a short offline
 * blip at boot heals without a reload and a long one costs a fetch every few
 * seconds rather than one per frame.
 */
const CORE_RETRY_AFTER_MS = 5_000

/** What a layout draws when this realm's core did not load. */
const CORE_UNAVAILABLE: LayoutRefusal = { code: 'malformed', reason: 'core-unavailable' }

/**
 * Answers every layout as refused, for a realm whose core did not load: each
 * surface already draws a refusal as its notice, so a missing core reads as
 * that and not as a blank board or an error screen. Routing has no refusal
 * arm and throws what the core throws for one, which its one caller (the
 * connect preview) answers by drawing no line.
 */
const unavailableCore: LayoutCore = {
  routing: {
    routeLayout() {
      const err = new Error('the Rust core did not load')
      err.name = 'CoreInputRefused'
      throw err
    },
  },
  layout: { layoutSpatialCanvas: () => ({ refused: CORE_UNAVAILABLE }) },
  markdown: { layoutMarkdown: () => ({ refused: CORE_UNAVAILABLE }) },
  query: { layoutQuery: () => ({ refused: CORE_UNAVAILABLE }) },
}

/** Rejects with `CoreLoadTimedOut` and aborts `load`'s signal when it outlives `timeoutMs`. */
function withinBound(
  load: (signal: AbortSignal) => Promise<WebCore>,
  timeoutMs: number,
): Promise<WebCore> {
  const controller = new AbortController()
  return new Promise<WebCore>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new CoreLoadTimedOut(timeoutMs)
      controller.abort(err)
      reject(err)
    }, timeoutMs)
    load(controller.signal).then(
      (core) => {
        clearTimeout(timer)
        resolve(core)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** `load`, shared by every ask; a failed load is forgotten, so the next ask tries again. */
function loadAtMostOnce(load: () => Promise<WebCore>): () => Promise<WebCore> {
  let loading: Promise<WebCore> | undefined
  return () => {
    loading ??= load().catch((err: unknown) => {
      loading = undefined
      throw err
    })
    return loading
  }
}

interface LayoutCoreHostOptions {
  readonly timeoutMs?: number
  readonly retryAfterMs?: number
  readonly now?: () => number
  readonly traps?: TrapPolicy
}

/** How many times a core became available, and who hears it move. */
function createAnnouncer(): Pick<LayoutCoreHost, 'generation' | 'subscribe'> & {
  announce(): void
} {
  let generation = 0
  const listeners = new Set<() => void>()
  return {
    generation: () => generation,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    announce() {
      generation += 1
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Asks again after a failed load: `now` starts one more load (or joins the
 * one in flight), and `scheduleOnce` arms a single one at the delay, for a board that
 * drew the notice and is not laid out again until the connection is back.
 */
function createRetry(attempt: () => Promise<unknown>, retryAfterMs: number) {
  let armed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Asking again while a load is in flight joins it (`loadAtMostOnce`).
  const now = (): void => void attempt().catch(() => undefined)
  return {
    now,
    scheduleOnce() {
      if (armed) return
      armed = true
      timer = setTimeout(now, retryAfterMs)
    },
    cancel: () => clearTimeout(timer),
  }
}

/**
 * `load` is called once for all, on the first ask of whichever half asks,
 * and abandoned past `timeoutMs`; a load that fails is forgotten, so the
 * next `ready` or `codecs` tries again.
 */
export function createLayoutCoreHost(
  load: (signal: AbortSignal) => Promise<WebCore>,
  {
    timeoutMs = CORE_LOAD_TIMEOUT_MS,
    retryAfterMs = CORE_RETRY_AFTER_MS,
    now = () => Date.now(),
    traps = 'refuse',
  }: LayoutCoreHostOptions = {},
): LayoutCoreHost {
  let layout: LayoutCore | undefined
  let failedAt: number | undefined
  const announcer = createAnnouncer()
  const loadOnce = loadAtMostOnce(() => withinBound(load, timeoutMs))

  const ready = (): Promise<LayoutCore> =>
    loadOnce().then(
      (core) => {
        failedAt = undefined
        retry.cancel()
        if (layout === undefined) {
          layout = layoutFrom(core, traps)
          announcer.announce()
        }
        return layout
      },
      (err: unknown) => {
        failedAt = now()
        retry.scheduleOnce()
        throw err
      },
    )
  const retry = createRetry(ready, retryAfterMs)

  return {
    ready,
    codecs: loadOnce,
    current() {
      if (layout !== undefined) return layout
      if (failedAt !== undefined) {
        if (now() - failedAt >= retryAfterMs) retry.now()
        return unavailableCore
      }
      void ready().catch(() => undefined)
      return undefined
    },
    generation: announcer.generation,
    subscribe: announcer.subscribe,
  }
}

let installed: LayoutCoreHost | undefined

/**
 * Makes this realm's host. Each realm that lays out installs once (the page
 * at boot, the layout worker at start). A realm that never does (a jsdom unit
 * test of a component) answers no core, and a layout asked there throws in
 * `requireLayoutCore`: there is no TypeScript composer to lay it out
 * (ADR-0054 step 7, S18h).
 */
export function installLayoutCore(options: { readonly traps?: TrapPolicy } = {}): LayoutCoreHost {
  // The platform's fetch as it stood now. The wasm is a build asset, not an
  // API call: a later replacement of `globalThis.fetch` (a test double
  // answering 404 to every route it was not told of) would otherwise be asked
  // for bytes it knows nothing about.
  const fetchAsset: typeof fetch = globalThis.fetch?.bind(globalThis)
  installed ??= createLayoutCoreHost(
    async (signal) => (await import('./layout-core-source.js')).loadWebCore(fetchAsset, signal),
    options,
  )
  return installed
}

/** Settles with this realm's core once loaded, rejecting when it cannot load; `undefined` when none is installed. */
export const layoutCoreReady = (): Promise<LayoutCore | undefined> =>
  installed?.ready() ?? Promise.resolve(undefined)

/**
 * The core this realm has loaded, `undefined` in a realm that installed none;
 * after a failed load, a core that refuses every layout as `core-unavailable`.
 */
export const currentLayoutCore = (): LayoutCore | undefined => installed?.current()

/** How many times this realm's core became available: 0 in a realm that installed none. */
export const layoutCoreGeneration = (): number => installed?.generation() ?? 0

/** Calls `listener` when this realm's core becomes available; a no-op where none is installed. */
export const subscribeLayoutCore = (listener: () => void): (() => void) =>
  installed?.subscribe(listener) ?? (() => undefined)
