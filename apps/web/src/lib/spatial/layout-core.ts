import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
// Types only: this module is on the page's critical path, and a value import
// of codec would carry its readers (the schemas) into the boot bundle.
// Installing the OKF core into codec is `okf-codec.ts`'s, which only the OKF
// call sites import.
import type { OkfCore, SpatialCodecCore, SpatialMismatch } from '@kamiazya/whiteboard-codec'
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
   * Starts the load on first call and settles with the OKF core, whatever the
   * routing and JSON Canvas switches read: OKF has no TypeScript to answer in
   * its place, so a load that fails rejects (and the next call tries again).
   */
  okf(): Promise<OkfCore>
  /** The same for the JSON Canvas codec. */
  currentSpatial(): SpatialCodecCore | undefined
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
  return mismatch.kind === 'differs'
    ? {
        fn: mismatch.fn,
        kind: mismatch.kind,
        at: mismatch.at,
        ts: mismatch.ts[mismatch.at],
        rust: mismatch.rust[mismatch.at],
        edges: mismatch.repro.edges.length,
      }
    : { fn: mismatch.fn, kind: mismatch.kind, err: mismatch.err }
}

/** A decline as it is reported: the function and the core's reason, never the text or document. */
function declineSummary(mismatch: { readonly fn: string; readonly err: unknown }) {
  const { err } = mismatch
  return {
    fn: mismatch.fn,
    reason: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
  }
}

/** The JSON Canvas codec's difference or decline, reported, or thrown under `throw` (`spatial-declined`). */
function spatialReporter(
  settings: CoreSettings,
  log: CoreLog,
): (mismatch: SpatialMismatch) => void {
  return (mismatch) => {
    if (mismatch.kind === 'declined') {
      const summary = declineSummary(mismatch)
      log.warn('the Rust core declined; answered in TypeScript', {
        event: 'spatial-declined',
        ...summary,
      })
      if (settings.mismatch === 'throw') {
        throw new Error(`JSON Canvas core declined: ${JSON.stringify(summary)}`)
      }
      return
    }
    const summary = { fn: mismatch.fn, kind: mismatch.kind, ts: mismatch.ts, rust: mismatch.rust }
    log.warn('the Rust core and the TypeScript disagree', summary)
    if (settings.mismatch === 'throw') {
      throw new Error(`JSON Canvas core ${mismatch.kind}: ${JSON.stringify(summary)}`)
    }
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

/** What one loaded instance answers, per switch: nothing for a switch that reads `ts`. */
function coresFrom(
  core: WebCore,
  settings: CoreSettings,
  log: CoreLog,
): {
  layout: LayoutCore | undefined
  spatial: SpatialCodecCore | undefined
} {
  const layout: LayoutCore | undefined =
    settings.impl === 'ts'
      ? undefined
      : {
          routing: core,
          impl: { routeLayout: settings.impl },
          onMismatch: layoutReporter(settings, log),
        }
  const spatial: SpatialCodecCore | undefined =
    settings.spatial === 'ts'
      ? undefined
      : {
          spatial: core,
          impl: { parseSpatial: settings.spatial, serializeSpatial: settings.spatial },
          onMismatch: spatialReporter(settings, log),
        }
  return { layout, spatial }
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
 * artifact that cannot load degrades routing and JSON Canvas to TypeScript
 * with a warning, unless mismatches throw: a test run that asked for the core and did not get it has
 * compared nothing. OKF cannot degrade, so `okf()` rejects instead.
 */
export function createLayoutCoreHost(
  settings: CoreSettings,
  load: () => Promise<WebCore>,
  log: CoreLog,
): LayoutCoreHost {
  let cores: ReturnType<typeof coresFrom> | undefined
  let failure: { readonly err: unknown } | undefined
  let started: Promise<LayoutCore | undefined> | undefined
  const loadOnce = loadAtMostOnce(load)
  // Routing and JSON Canvas load nothing while both read `ts`; OKF loads on its own ask.
  const answersInRust = settings.impl !== 'ts' || settings.spatial !== 'ts'

  const start = (): Promise<LayoutCore | undefined> => {
    if (!answersInRust) return Promise.resolve(undefined)
    started ??= loadOnce().then(
      (core) => {
        cores = coresFrom(core, settings, log)
        return cores.layout
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
    okf: loadOnce,
    current() {
      startAndRaise()
      return cores?.layout
    },
    currentSpatial() {
      startAndRaise()
      return cores?.spatial
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

/** The JSON Canvas core this realm has loaded so far, or `undefined` under `ts` or before the load. */
export const currentSpatialCore = (): SpatialCodecCore | undefined => installed?.currentSpatial()
