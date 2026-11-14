import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
// Types only: this module is on the page's critical path, and a value import
// of codec would carry its readers (the schemas) into the boot bundle.
// Installing the OKF and JSON Canvas cores into codec is `codec-cores.ts`'s,
// which only the call sites that read or write them import.
import { type CoreSettings, coreSettingsFrom } from './layout-core-settings.js'
import type { WebCore } from './web-core.js'

/**
 * The Rust routing core as this realm holds it: the page and the layout
 * worker each build their own, since a wasm instance is not shared across
 * realms. `current` is synchronous because the layouts that ask (a drag
 * frame, the main-thread fallback) cannot wait; before the load settles it
 * answers nothing and they route in TypeScript. A worker awaits `ready`
 * before its first layout instead.
 */
export interface LayoutCoreHost {
  /** Starts the load on first call; settles with the core, or `undefined` when none is in use. */
  ready(): Promise<LayoutCore | undefined>
  /** The loaded core, or `undefined` before it loads. Starts the load, and throws a failed one under `throw`. */
  current(): LayoutCore | undefined
  /**
   * Starts the load on first call and settles with the core the OKF and JSON
   * Canvas codecs answer through, whatever the routing switch reads: they have
   * no TypeScript to answer in their place, so a load that fails rejects (and
   * the next call tries again).
   */
  codecs(): Promise<WebCore>
}

/**
 * Where the host reports to. Structural, and injected by the realm that
 * installs it: this directory is below `lib/` and may not import its logger.
 */
export interface CoreLog {
  warn(message: string, data?: unknown): void
  debug(message: string, data?: unknown): void
}

function summarize(mismatch: CoreMismatch) {
  if (mismatch.kind !== 'differs')
    return { fn: mismatch.fn, kind: mismatch.kind, err: mismatch.err }
  // The page never switches the whole layout on (it measures with a canvas
  // context, which the core cannot repeat), so only a routing difference
  // reaches here; the whole layout's is read for the type's sake.
  if (mismatch.fn === 'layoutSpatialCanvas') {
    const { fn, kind, at, ts, rust } = mismatch
    return { fn, kind, at, ts, rust, nodes: mismatch.repro.canvas.nodes.length }
  }
  return {
    fn: mismatch.fn,
    kind: mismatch.kind,
    at: mismatch.at,
    ts: mismatch.ts[mismatch.at],
    rust: mismatch.rust[mismatch.at],
    edges: mismatch.repro.edges.length,
  }
}

function layoutReporter(settings: CoreSettings, log: CoreLog): (mismatch: CoreMismatch) => void {
  return (mismatch) => {
    const summary = summarize(mismatch)
    log.warn('the Rust core and the TypeScript disagree', summary)
    log.debug('what reproduces it', mismatch.repro)
    if (settings.mismatch === 'throw') {
      throw new Error(`layout core ${mismatch.kind}: ${JSON.stringify(summary)}`)
    }
  }
}

/** What one loaded instance answers for routing: nothing for a switch that reads `ts`. */
function layoutFrom(core: WebCore, settings: CoreSettings, log: CoreLog): LayoutCore | undefined {
  return settings.impl === 'ts'
    ? undefined
    : {
        routing: core,
        impl: { routeLayout: settings.impl },
        onMismatch: layoutReporter(settings, log),
      }
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

/**
 * `load` is called once for all, on the first ask of whichever half asks. An
 * artifact that cannot load degrades routing to TypeScript with a warning,
 * unless mismatches throw: a test run that asked for the core and did not get it
 * has compared nothing. The codecs cannot degrade, so `codecs()` rejects instead.
 */
export function createLayoutCoreHost(
  settings: CoreSettings,
  load: () => Promise<WebCore>,
  log: CoreLog,
): LayoutCoreHost {
  let layout: LayoutCore | undefined
  let failure: { readonly err: unknown } | undefined
  let started: Promise<LayoutCore | undefined> | undefined
  const loadOnce = loadAtMostOnce(load)
  // Routing loads nothing while it reads `ts`; the codecs load on their own ask.
  const answersInRust = settings.impl !== 'ts'

  const start = (): Promise<LayoutCore | undefined> => {
    if (!answersInRust) return Promise.resolve(undefined)
    started ??= loadOnce().then(
      (core) => {
        layout = layoutFrom(core, settings, log)
        return layout
      },
      (err: unknown) => {
        failure = { err }
        if (settings.mismatch === 'throw') throw err
        log.warn('the Rust core did not load; answering in TypeScript', err)
        return undefined
      },
    )
    return started
  }

  // A failed load under `throw` was already surfaced through `ready`; the
  // synchronous readers have no promise to reject, so they raise the same error.
  const startAndRaise = (): void => {
    if (!answersInRust) return
    void start().catch(() => undefined)
    if (failure !== undefined && settings.mismatch === 'throw') throw failure.err
  }

  return {
    ready: start,
    codecs: loadOnce,
    current() {
      startAndRaise()
      return layout
    },
  }
}

let installed: LayoutCoreHost | undefined

/**
 * Makes this realm's host from the build's environment. Each realm that lays
 * out installs once (the page at boot, the layout worker at start): a realm
 * that never does routes in TypeScript, which is what a unit test of a
 * component wants.
 */
export function installLayoutCore(log: CoreLog): LayoutCoreHost {
  // The platform's fetch as it stood now. The wasm is a build asset, not an
  // API call: a later replacement of `globalThis.fetch` (a test double
  // answering 404 to every route it was not told of) would otherwise be asked
  // for bytes it knows nothing about.
  const fetchAsset: typeof fetch = globalThis.fetch?.bind(globalThis)
  installed ??= createLayoutCoreHost(
    coreSettingsFrom(import.meta.env),
    async () => (await import('./layout-core-source.js')).loadWebCore(fetchAsset),
    log,
  )
  return installed
}

/** Settles with this realm's core once loaded; `undefined` when none is installed or in use. */
export const layoutCoreReady = (): Promise<LayoutCore | undefined> =>
  installed?.ready() ?? Promise.resolve(undefined)

/** The core this realm has loaded so far, or `undefined`. */
export const currentLayoutCore = (): LayoutCore | undefined => installed?.current()
