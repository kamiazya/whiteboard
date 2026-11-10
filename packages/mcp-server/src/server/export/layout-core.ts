import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import type {
  OkfCodecCore,
  OkfMismatch,
  SpatialCodecCore,
  SpatialMismatch,
} from '@kamiazya/whiteboard-codec'
import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { z } from 'zod'
import { findPackageRoot } from '../../shared/package-root.js'
import { getLogger } from '../log.js'

const log = getLogger('layout-core')

/**
 * How this daemon routes a canvas's edges (ADR-0054's `CoreImpl`), from
 * its environment. `WHITEBOARD_CORE` is `rust` unless something sets it: the
 * Rust core answers and a published daemon pays for no second routing. The
 * dev scripts and CI's test jobs set `differential` to compare it with the
 * TypeScript; `ts` is the rollback while the TypeScript exists.
 * `WHITEBOARD_CORE_MISMATCH=throw` turns a reported difference into a
 * failure, which is what a test run wants; a person dogfooding wants the
 * log line and the drawing.
 *
 * `WHITEBOARD_CORE_OKF` is the same switch for the OKF envelope (every read
 * and write of an OKF Markdown document). It is `rust` unless something sets
 * it, like `WHITEBOARD_CORE`: the OKF port has passed its parity checklist
 * (docs/contributing/parity/okf-codec.md). The dev scripts and CI's test jobs
 * set `differential`; `ts` is the rollback while the TypeScript exists. A text
 * the Rust core declines is answered by the TypeScript in every mode.
 *
 * `WHITEBOARD_CORE_SPATIAL` is the same switch for the JSON Canvas codec
 * (every read and write of a JSON Canvas document). It is `rust` unless
 * something sets it, like the others: the port passed its parity checklist
 * (docs/contributing/parity/json-canvas-codec.md), and the owner chose the
 * core despite its boundary cost (decision q39). The dev scripts and CI's
 * test jobs set `differential`; `ts` is the rollback while the TypeScript
 * exists.
 */
const layoutCoreSettingsSchema = z.object({
  WHITEBOARD_CORE: z.enum(['ts', 'differential', 'rust']).default('rust'),
  WHITEBOARD_CORE_OKF: z.enum(['ts', 'differential', 'rust']).default('rust'),
  WHITEBOARD_CORE_SPATIAL: z.enum(['ts', 'differential', 'rust']).default('rust'),
  WHITEBOARD_CORE_MISMATCH: z.enum(['log', 'throw']).default('log'),
  WHITEBOARD_CORE_DIR: z.string().min(1).optional(),
})
export type LayoutCoreSettings = z.infer<typeof layoutCoreSettingsSchema>

export function layoutCoreSettingsFrom(env: Readonly<Record<string, string | undefined>>) {
  return layoutCoreSettingsSchema.parse({
    WHITEBOARD_CORE: env.WHITEBOARD_CORE || undefined,
    WHITEBOARD_CORE_OKF: env.WHITEBOARD_CORE_OKF || undefined,
    WHITEBOARD_CORE_SPATIAL: env.WHITEBOARD_CORE_SPATIAL || undefined,
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

/**
 * Where a published install carries the artifact: `build` copies it beside
 * the other assets (packages/mcp-server/scripts/copy-core-wasm-into-dist.mjs), because a tarball
 * has no sibling `core-wasm` package to find.
 */
export const packagedArtifacts = (): string =>
  join(findPackageRoot(import.meta.url), 'dist', 'assets', 'core-wasm')

interface ArtifactCandidates {
  readonly packaged: string
  readonly staged: string
}

/**
 * The directory holding the glue and wasm: the one the environment names,
 * else the packaged copy when this install has one, else the checkout's.
 */
export function artifactDirectory(
  settings: LayoutCoreSettings,
  candidates: ArtifactCandidates = { packaged: packagedArtifacts(), staged: stagedArtifacts() },
): string {
  if (settings.WHITEBOARD_CORE_DIR !== undefined) return settings.WHITEBOARD_CORE_DIR
  return existsSync(join(candidates.packaged, 'whiteboard_wasm_bg.wasm'))
    ? candidates.packaged
    : candidates.staged
}

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

/** A decline as it is reported: the function and the core's reason, never the text or document. */
function declineSummary(mismatch: { readonly fn: string; readonly err: unknown }) {
  const { err } = mismatch
  return {
    fn: mismatch.fn,
    reason: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
  }
}

/**
 * A codec's difference or decline, reported, or thrown under `throw`. A
 * decline is answered by the TypeScript, so only a run that asked to fail on
 * one sees it as a failure; otherwise it is a counted record
 * (`event: 'okf-declined'` or `'spatial-declined'`).
 */
function codecReporter(
  settings: LayoutCoreSettings,
  codec: 'okf' | 'spatial',
): (mismatch: OkfMismatch | SpatialMismatch) => void {
  const name = codec === 'okf' ? 'OKF' : 'JSON Canvas'
  return (mismatch) => {
    if (mismatch.kind === 'declined') {
      const summary = declineSummary(mismatch)
      log.warning(
        { event: `${codec}-declined`, ...summary },
        'the Rust core declined; answered in TypeScript',
      )
      if (settings.WHITEBOARD_CORE_MISMATCH === 'throw') {
        throw new Error(`${name} core declined: ${JSON.stringify(summary)}`)
      }
      return
    }
    const summary = { fn: mismatch.fn, kind: mismatch.kind, ts: mismatch.ts, rust: mismatch.rust }
    log.warning(summary, 'the Rust core and the TypeScript disagree')
    if (settings.WHITEBOARD_CORE_MISMATCH === 'throw') {
      throw new Error(`${name} core ${mismatch.kind}: ${JSON.stringify(summary)}`)
    }
  }
}

/** The `ServerDeps` factories the core serves, over one load. */
export interface CoreLoaders {
  readonly layoutCore: () => Promise<LayoutCore | undefined>
  readonly okfCore: () => Promise<OkfCodecCore | undefined>
  readonly spatialCore: () => Promise<SpatialCodecCore | undefined>
}

/**
 * The `ServerDeps.layoutCore`, `ServerDeps.okfCore` and
 * `ServerDeps.spatialCore` factories: nothing loaded while every switch reads
 * `ts`, else the staged glue and wasm read
 * once, on the first call that asks, and shared by all. The glue is
 * imported by PATH at run time, never bundled, so a build of this package
 * needs no artifact. An artifact that cannot be read degrades to the
 * TypeScript with a warning carrying `event: 'core-load-failed'` (so a
 * deployment can count it), unless mismatches throw: a test run that asked
 * for the core and did not get it has compared nothing.
 */
export function coreLoaders(settings: LayoutCoreSettings): CoreLoaders {
  const routing = settings.WHITEBOARD_CORE
  const okf = settings.WHITEBOARD_CORE_OKF
  const spatial = settings.WHITEBOARD_CORE_SPATIAL
  const loadCore = coreLoader(settings)
  return {
    layoutCore: memoized(routing, loadCore, (core) => ({
      routing: core,
      impl: { routeLayout: routing },
      onMismatch: reporter(settings),
    })),
    okfCore: memoized(okf, loadCore, (core) => ({
      okf: core,
      impl: { parseOkf: okf, serializeOkf: okf },
      onMismatch: codecReporter(settings, 'okf'),
    })),
    spatialCore: memoized(spatial, loadCore, (core) => ({
      spatial: core,
      impl: { parseSpatial: spatial, serializeSpatial: spatial },
      onMismatch: codecReporter(settings, 'spatial'),
    })),
  }
}

/** The staged glue and wasm, read once on the first call that asks. */
function coreLoader(settings: LayoutCoreSettings): () => Promise<Core | undefined> {
  let loaded: Promise<Core | undefined> | undefined
  return () => {
    loaded ??= (async () => {
      const dir = artifactDirectory(settings)
      try {
        const glue = (await import(pathToFileURL(join(dir, 'whiteboard_wasm.js')).href)) as CoreGlue
        const bytes = await readFile(join(dir, 'whiteboard_wasm_bg.wasm'))
        return coreFrom(glue, bytes)
      } catch (err) {
        if (settings.WHITEBOARD_CORE_MISMATCH === 'throw') throw err
        log.warning(
          { event: 'core-load-failed', dir, err },
          'the Rust core did not load; answering in TypeScript',
        )
        return undefined
      }
    })()
    return loaded
  }
}

/** One switch's factory: nothing under `ts`, else what `wrap` makes of the core, built once. */
function memoized<T>(
  impl: 'ts' | 'differential' | 'rust',
  loadCore: () => Promise<Core | undefined>,
  wrap: (core: Core) => T,
): () => Promise<T | undefined> {
  let built: Promise<T | undefined> | undefined
  return () => {
    if (impl === 'ts') return Promise.resolve(undefined)
    built ??= loadCore().then((core) => (core === undefined ? undefined : wrap(core)))
    return built
  }
}
