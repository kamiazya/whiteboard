import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
// Types only: this module is on the page's critical path, and a value import
// of codec would carry its OKF reader (yaml, the schemas) into the boot bundle.
// The codec itself is `okf-codec.ts`'s, which only the OKF call sites import.
import type { OkfCodecCore, OkfMismatch } from '@kamiazya/whiteboard-codec'
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

function okfReporter(settings: CoreSettings, log: CoreLog): (mismatch: OkfMismatch) => void {
  return (mismatch) => {
    if (mismatch.kind === 'declined') {
      log.debug('the Rust core declined; answered in TypeScript', mismatch)
      return
    }
    const summary = { fn: mismatch.fn, kind: mismatch.kind, ts: mismatch.ts, rust: mismatch.rust }
    log.warn('the Rust core and the TypeScript disagree', summary)
    if (settings.mismatch === 'throw') {
      throw new Error(`OKF core ${mismatch.kind}: ${JSON.stringify(summary)}`)
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
): { layout: LayoutCore | undefined; okf: OkfCodecCore | undefined } {
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
          onMismatch: okfReporter(settings, log),
        }
  return { layout, okf }
}

/**
 * `load` is called only when routing or OKF reads anything but `ts`, once
 * for both. An artifact that
 * cannot load degrades to TypeScript with a warning, unless mismatches
 * throw: a test run that asked for the core and did not get it has compared
 * nothing.
 */
export function createLayoutCoreHost(
  settings: CoreSettings,
  load: () => Promise<WebCore>,
  log: CoreLog,
): LayoutCoreHost {
  let layout: LayoutCore | undefined
  let okf: OkfCodecCore | undefined
  let failure: { readonly err: unknown } | undefined
  let started: Promise<LayoutCore | undefined> | undefined

  const start = (): Promise<LayoutCore | undefined> => {
    started ??= load().then(
      (core) => {
        ;({ layout, okf } = coresFrom(core, settings, log))
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
    void start().catch(() => undefined)
    if (failure !== undefined && settings.mismatch === 'throw') throw failure.err
  }

  if (settings.impl === 'ts' && settings.okf === 'ts') {
    return { ready: async () => undefined, current: () => undefined, currentOkf: () => undefined }
  }
  return {
    ready: start,
    current() {
      startAndRaise()
      return layout
    },
    currentOkf() {
      startAndRaise()
      return okf
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
