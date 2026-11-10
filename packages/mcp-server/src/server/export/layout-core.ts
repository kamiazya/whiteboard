import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreMismatch, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import {
  installOkfCore,
  installSpatialCore,
  okfCoreInstalled,
  spatialCoreInstalled,
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
 * The OKF envelope and the JSON Canvas codec have no switch: their TypeScript
 * is deleted (docs/contributing/parity/okf-codec.md,
 * docs/contributing/parity/json-canvas-codec.md), so the daemon installs the
 * core at boot (`installCodecCoresAtBoot`) and refuses to start without it.
 */
const layoutCoreSettingsSchema = z.object({
  WHITEBOARD_CORE: z.enum(['ts', 'differential', 'rust']).default('rust'),
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

/** The `ServerDeps` factory the core serves, over one load. */
export interface CoreLoaders {
  readonly layoutCore: () => Promise<LayoutCore | undefined>
}

/**
 * The `ServerDeps.layoutCore` factory: nothing loaded while the switch reads
 * `ts`, else the staged glue and wasm read once, on the first call that asks
 * (or at boot, which shares the one load). The glue is
 * imported by PATH at run time, never bundled, so a build of this package
 * needs no artifact. An artifact that cannot be read degrades to the
 * TypeScript with a warning carrying `event: 'core-load-failed'` (so a
 * deployment can count it), unless mismatches throw: a test run that asked
 * for the core and did not get it has compared nothing.
 */
export function coreLoaders(settings: LayoutCoreSettings): CoreLoaders {
  const routing = settings.WHITEBOARD_CORE
  const loadCore = coreLoader(settings)
  return {
    layoutCore: memoized(routing, loadCore, (core) => ({
      routing: core,
      impl: { routeLayout: routing },
      onMismatch: reporter(settings),
    })),
  }
}

/**
 * The glue and wasm in `dir`, read once per directory for the whole process,
 * so the codec install at boot and the lazy routing load share
 * one instance. A load that failed is forgotten, so the next ask tries again.
 */
const loadedByDirectory = new Map<string, Promise<Core>>()

function loadCoreFrom(dir: string): Promise<Core> {
  let loaded = loadedByDirectory.get(dir)
  if (loaded === undefined) {
    loaded = (async () => {
      const glue = (await import(pathToFileURL(join(dir, 'whiteboard_wasm.js')).href)) as CoreGlue
      const bytes = await readFile(join(dir, 'whiteboard_wasm_bg.wasm'))
      return coreFrom(glue, bytes)
    })()
    loaded.catch(() => loadedByDirectory.delete(dir))
    loadedByDirectory.set(dir, loaded)
  }
  return loaded
}

/** The staged glue and wasm, read on the first call that asks. */
function coreLoader(settings: LayoutCoreSettings): () => Promise<Core | undefined> {
  let loaded: Promise<Core | undefined> | undefined
  return () => {
    loaded ??= (async () => {
      const dir = artifactDirectory(settings)
      try {
        return await loadCoreFrom(dir)
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

/**
 * Installs the Rust core as this process's OKF and JSON Canvas codecs, before
 * anything is served. Neither has a TypeScript to degrade to, so a daemon that
 * cannot load the artifact refuses to start, naming where it looked, rather
 * than failing its first read of a document. A realm that already installed
 * both (a test realm) keeps them.
 */
export async function installCodecCoresAtBoot(
  settings: LayoutCoreSettings = layoutCoreSettingsFrom(process.env),
): Promise<void> {
  if (okfCoreInstalled() && spatialCoreInstalled()) return
  const dir = artifactDirectory(settings)
  try {
    const core = await loadCoreFrom(dir)
    if (!okfCoreInstalled()) installOkfCore(core)
    if (!spatialCoreInstalled()) installSpatialCore(core)
  } catch (err) {
    throw new Error(
      `the Rust core is required to read and write OKF Markdown and JSON Canvas and did not load from ${dir}; build it with \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\` or point WHITEBOARD_CORE_DIR at a directory holding it`,
      { cause: err },
    )
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
