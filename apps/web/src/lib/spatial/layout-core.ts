import type { CoreMismatch, LayoutCore, RoutingCore } from '@kamiazya/whiteboard-canvas-render'
import { type AppLogger, getAppLogger } from '../app-logger.js'
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
  log: AppLogger,
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

const host = createLayoutCoreHost(
  coreSettingsFrom(import.meta.env),
  // A build that routes in TypeScript replaces `layout-core-source.ts` with a
  // stub (vite-plugin-core-source.ts), so this import never reaches the wasm.
  async () => (await import('./layout-core-source.js')).loadWebCore(),
  getAppLogger('layout-core'),
)

export const layoutCoreReady = host.ready
export const currentLayoutCore = host.current
