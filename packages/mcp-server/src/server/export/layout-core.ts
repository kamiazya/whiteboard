import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { z } from 'zod'
import { findPackageRoot } from '../../shared/package-root.js'
import { getLogger } from '../log.js'

const log = getLogger('layout-core')

/**
 * How this daemon routes a canvas's edges (ADR-0054's `CoreImpl`), from
 * its environment. `WHITEBOARD_CORE` is `ts` unless something sets it: the
 * dev scripts and CI's test jobs set `differential`, a release never does,
 * so a published daemon neither pays for a second routing nor needs the
 * wasm. `WHITEBOARD_CORE_MISMATCH=throw` turns a reported difference into a
 * failure, which is what a test run wants; a person dogfooding wants the
 * log line and the drawing.
 */
const layoutCoreSettingsSchema = z.object({
  WHITEBOARD_CORE: z.enum(['ts', 'differential', 'rust']).default('ts'),
  WHITEBOARD_CORE_MISMATCH: z.enum(['log', 'throw']).default('log'),
  WHITEBOARD_CORE_DIR: z.string().min(1).optional(),
})
export type LayoutCoreSettings = z.infer<typeof layoutCoreSettingsSchema>

export function layoutCoreSettingsFrom(env: Readonly<Record<string, string | undefined>>) {
  return layoutCoreSettingsSchema.parse({
    WHITEBOARD_CORE: env.WHITEBOARD_CORE || undefined,
    WHITEBOARD_CORE_MISMATCH: env.WHITEBOARD_CORE_MISMATCH || undefined,
    WHITEBOARD_CORE_DIR: env.WHITEBOARD_CORE_DIR || undefined,
  })
}

/**
 * Where `stage:wasm` puts the artifact in this checkout: core-wasm beside
 * this package. A daemon run from anywhere else names its own directory.
 */
export const stagedArtifacts = (): string =>
  join(findPackageRoot(import.meta.url), '..', 'core-wasm', 'artifacts')

/** A mismatch reported, or thrown when the settings ask a test run to fail on one. */
function reporter(settings: LayoutCoreSettings): (mismatch: CoreMismatch) => void {
  return (mismatch) => {
    const summary =
      mismatch.kind === 'differs'
        ? {
            fn: mismatch.fn,
            kind: mismatch.kind,
            at: mismatch.at,
            ts: mismatch.ts[mismatch.at],
            rust: mismatch.rust[mismatch.at],
            edges: mismatch.repro.edges.length,
          }
        : { fn: mismatch.fn, kind: mismatch.kind, err: mismatch.err }
    log.warning(summary, 'the Rust core and the TypeScript disagree')
    log.debug({ repro: mismatch.repro }, 'what reproduces it')
    if (settings.WHITEBOARD_CORE_MISMATCH === 'throw') {
      throw new Error(`layout core ${mismatch.kind}: ${JSON.stringify(summary)}`)
    }
  }
}

/**
 * The `ServerDeps.layoutCore` factory: nothing loaded under `ts`, else the
 * staged glue and wasm read once, on the first layout that asks. The glue is
 * imported by PATH at run time, never bundled, so a build of this package
 * needs no artifact. An artifact that cannot be read degrades to the
 * TypeScript with a warning, unless mismatches throw: a test run that asked
 * for the core and did not get it has compared nothing.
 */
export function layoutCoreLoader(
  settings: LayoutCoreSettings,
): () => Promise<LayoutCore | undefined> {
  const impl = settings.WHITEBOARD_CORE
  if (impl === 'ts') return async () => undefined
  let loaded: Promise<LayoutCore | undefined> | undefined
  return () => {
    loaded ??= (async () => {
      const dir = settings.WHITEBOARD_CORE_DIR ?? stagedArtifacts()
      try {
        const glue = (await import(pathToFileURL(join(dir, 'whiteboard_wasm.js')).href)) as CoreGlue
        const bytes = await readFile(join(dir, 'whiteboard_wasm_bg.wasm'))
        const routing = coreFrom(glue, bytes)
        return { routing, impl: { routeLayout: impl }, onMismatch: reporter(settings) }
      } catch (err) {
        if (settings.WHITEBOARD_CORE_MISMATCH === 'throw') throw err
        log.warning({ dir, err }, 'the Rust core did not load; routing in TypeScript')
        return undefined
      }
    })()
    return loaded
  }
}
