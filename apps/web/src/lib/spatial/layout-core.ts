import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
// Types only: this module is on the page's critical path, and a value import
// of codec would carry its OKF reader (yaml, the schemas) into the boot bundle.
// The codec itself is `okf-codec.ts`'s, which only the OKF call sites import.
import type {
  OkfCodecCore,
  OkfMismatch,
  SpatialCodecCore,
  SpatialMismatch,
} from '@kamiazya/whiteboard-codec'
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
  /** The same for the OKF envelope: `undefined` under `ts` and before the load settles. */
  currentOkf(): OkfCodecCore | undefined
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

/** A codec's difference or decline, reported, or thrown under `throw` (`okf-declined` / `spatial-declined`). */
function codecReporter(
  settings: CoreSettings,
  log: CoreLog,
  codec: 'okf' | 'spatial',
): (mismatch: OkfMismatch | SpatialMismatch) => void {
  const name = codec === 'okf' ? 'OKF' : 'JSON Canvas'
  return (mismatch) => {
    if (mismatch.kind === 'declined') {
      const summary = declineSummary(mismatch)
      log.warn('the Rust core declined; answered in TypeScript', {
        event: `${codec}-declined`,
        ...summary,
      })
      if (settings.mismatch === 'throw') {
        throw new Error(`${name} core declined: ${JSON.stringify(summary)}`)
      }
      return
    }
    const summary = { fn: mismatch.fn, kind: mismatch.kind, ts: mismatch.ts, rust: mismatch.rust }
    log.warn('the Rust core and the TypeScript disagree', summary)
    if (settings.mismatch === 'throw') {
      throw new Error(`${name} core ${mismatch.kind}: ${JSON.stringify(summary)}`)
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
  okf: OkfCodecCore | undefined
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
  const okf: OkfCodecCore | undefined =
    settings.okf === 'ts'
      ? undefined
      : {
          okf: core,
          impl: { parseOkf: settings.okf, serializeOkf: settings.okf },
          onMismatch: codecReporter(settings, log, 'okf'),
        }
  const spatial: SpatialCodecCore | undefined =
    settings.spatial === 'ts'
      ? undefined
      : {
          spatial: core,
          impl: { parseSpatial: settings.spatial, serializeSpatial: settings.spatial },
          onMismatch: codecReporter(settings, log, 'spatial'),
        }
  return { layout, okf, spatial }
}

/** The host of a realm whose every switch reads `ts`: nothing to load, nothing to answer. */
const NO_CORE: LayoutCoreHost = {
  ready: async () => undefined,
  current: () => undefined,
  currentOkf: () => undefined,
  currentSpatial: () => undefined,
}

/**
 * `load` is called only when routing, OKF or JSON Canvas reads anything but
 * `ts`, once for all. An artifact that
 * cannot load degrades to TypeScript with a warning, unless mismatches
 * throw: a test run that asked for the core and did not get it has compared
 * nothing.
 */
export function createLayoutCoreHost(
  settings: CoreSettings,
  load: () => Promise<WebCore>,
  log: CoreLog,
): LayoutCoreHost {
  let cores: ReturnType<typeof coresFrom> | undefined
  let failure: { readonly err: unknown } | undefined
  let started: Promise<LayoutCore | undefined> | undefined

  const start = (): Promise<LayoutCore | undefined> => {
    started ??= load().then(
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
    void start().catch(() => undefined)
    if (failure !== undefined && settings.mismatch === 'throw') throw failure.err
  }

  if (settings.impl === 'ts' && settings.okf === 'ts' && settings.spatial === 'ts') return NO_CORE
  return {
    ready: start,
    current() {
      startAndRaise()
      return cores?.layout
    },
    currentOkf() {
      startAndRaise()
      return cores?.okf
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
    // A build that routes in TypeScript replaces `layout-core-source.ts` with
    // a stub (vite-plugin-core-source.ts), so this import never reaches the wasm.
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

/** The OKF core this realm has loaded so far, or `undefined` under `ts` or before the load. */
export const currentOkfCore = (): OkfCodecCore | undefined => installed?.currentOkf()

/** The JSON Canvas core this realm has loaded so far, or `undefined` under `ts` or before the load. */
export const currentSpatialCore = (): SpatialCodecCore | undefined => installed?.currentSpatial()
