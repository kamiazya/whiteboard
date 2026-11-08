import type { CoreMismatch, LayoutCore, RoutingCore } from '@kamiazya/whiteboard-canvas-render'
import { type CoreSettings, coreSettingsFrom } from './layout-core-settings.js'

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

/**
 * `load` is only ever called for an `impl` other than `ts`. An artifact that
 * cannot load degrades to TypeScript with a warning, unless mismatches
 * throw: a test run that asked for the core and did not get it has compared
 * nothing.
 */
export function createLayoutCoreHost(
  settings: CoreSettings,
  load: () => Promise<RoutingCore>,
  log: CoreLog,
): LayoutCoreHost {
  let loaded: LayoutCore | undefined
  let failure: { readonly err: unknown } | undefined
  let started: Promise<LayoutCore | undefined> | undefined

  const onMismatch = (mismatch: CoreMismatch): void => {
    const summary = summarize(mismatch)
    log.warn('the Rust core and the TypeScript disagree', summary)
    log.debug('what reproduces it', mismatch.repro)
    if (settings.mismatch === 'throw') {
      throw new Error(`layout core ${mismatch.kind}: ${JSON.stringify(summary)}`)
    }
  }

  const start = (): Promise<LayoutCore | undefined> => {
    started ??= load().then(
      (routing) => {
        loaded = { routing, impl: { routeLayout: settings.impl }, onMismatch }
        return loaded
      },
      (err: unknown) => {
        failure = { err }
        if (settings.mismatch === 'throw') throw err
        log.warn('the Rust core did not load; routing in TypeScript', err)
        return undefined
      },
    )
    return started
  }

  if (settings.impl === 'ts') return { ready: async () => undefined, current: () => undefined }
  return {
    ready: start,
    current() {
      // A failed load under `throw` was already surfaced through `ready`;
      // `current` has no promise to reject, so it raises the same error.
      void start().catch(() => undefined)
      if (failure !== undefined && settings.mismatch === 'throw') throw failure.err
      return loaded
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
