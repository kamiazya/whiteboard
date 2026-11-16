import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
// Types only: this module is on the page's critical path, and a value import
// of codec would carry its readers (the schemas) into the boot bundle.
// Installing the OKF and JSON Canvas cores into codec is `codec-cores.ts`'s,
// which only the call sites that read or write them import.
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
   * that awaited `ready` never sees. Starts the load, and throws a failed one,
   * so a layout after a failed load is an error its surface shows.
   */
  current(): LayoutCore | undefined
  /**
   * Starts the load on first call and settles with the core the OKF and JSON
   * Canvas codecs answer through: a load that fails rejects (and the next call
   * tries again).
   */
  codecs(): Promise<WebCore>
}

/** What one loaded instance answers: every layout entry, through the one instance. */
const layoutFrom = (core: WebCore): LayoutCore => ({
  routing: core,
  layout: core,
  markdown: core,
  query: core,
})

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

/**
 * `load` is called once for all, on the first ask of whichever half asks; a
 * load that fails is forgotten, so the next `ready` or `codecs` tries again.
 */
export function createLayoutCoreHost(load: () => Promise<WebCore>): LayoutCoreHost {
  let layout: LayoutCore | undefined
  let failure: { readonly err: unknown } | undefined
  const loadOnce = loadAtMostOnce(load)

  const ready = (): Promise<LayoutCore> =>
    loadOnce().then(
      (core) => {
        failure = undefined
        layout ??= layoutFrom(core)
        return layout
      },
      (err: unknown) => {
        failure = { err }
        throw err
      },
    )

  return {
    ready,
    codecs: loadOnce,
    current() {
      if (layout !== undefined) return layout
      if (failure !== undefined) throw failure.err
      void ready().catch(() => undefined)
      return undefined
    },
  }
}

let installed: LayoutCoreHost | undefined

/**
 * Makes this realm's host. Each realm that lays out installs once (the page
 * at boot, the layout worker at start). A realm that never does (a jsdom unit
 * test of a component) answers no core, and its layouts are the TypeScript
 * composer's, which S18h deletes with the TypeScript itself.
 */
export function installLayoutCore(): LayoutCoreHost {
  // The platform's fetch as it stood now. The wasm is a build asset, not an
  // API call: a later replacement of `globalThis.fetch` (a test double
  // answering 404 to every route it was not told of) would otherwise be asked
  // for bytes it knows nothing about.
  const fetchAsset: typeof fetch = globalThis.fetch?.bind(globalThis)
  installed ??= createLayoutCoreHost(async () =>
    (await import('./layout-core-source.js')).loadWebCore(fetchAsset),
  )
  return installed
}

/** Settles with this realm's core once loaded, rejecting when it cannot load; `undefined` when none is installed. */
export const layoutCoreReady = (): Promise<LayoutCore | undefined> =>
  installed?.ready() ?? Promise.resolve(undefined)

/** The core this realm has loaded, `undefined` in a realm that installed none; throws a failed load. */
export const currentLayoutCore = (): LayoutCore | undefined => installed?.current()
