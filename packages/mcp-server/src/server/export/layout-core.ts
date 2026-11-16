import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import {
  installOkfCore,
  installSpatialCore,
  okfCoreInstalled,
  spatialCoreInstalled,
} from '@kamiazya/whiteboard-codec'
import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import { facetWriteCoreInstalled, installFacetWriteCore } from '@kamiazya/whiteboard-server-core'
import { z } from 'zod'
import { findPackageRoot } from '../../shared/package-root.js'

/**
 * Where this daemon finds the Rust core (ADR-0054), from its environment:
 * `WHITEBOARD_CORE_DIR` names the directory holding the glue and wasm, else
 * the packaged copy or the checkout's staged one (`artifactDirectory`).
 *
 * The core answers every layout, every markdown note and every layout piece a
 * tool asks on its own (a text node's fitted height for `wb_canvas_edit`), as
 * it answers the OKF envelope, the JSON Canvas codec and the facet write: the
 * switches that could send a layout to the TypeScript are retired (ADR-0054
 * step 7, S18g), so the daemon installs the core at boot
 * (`installRustCoresAtBoot`) and refuses to start without it.
 */
const layoutCoreSettingsSchema = z.object({
  WHITEBOARD_CORE_DIR: z.string().min(1).optional(),
})
export type LayoutCoreSettings = z.infer<typeof layoutCoreSettingsSchema>

export function layoutCoreSettingsFrom(env: Readonly<Record<string, string | undefined>>) {
  return layoutCoreSettingsSchema.parse({
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

/**
 * The plugin ids the Rust core's facet registry holds: the bundled `visual`
 * plugin it is built from (plugin-visual's JSON asset tables). A deployment
 * whose registry holds any other set cannot be judged by it.
 */
export const RUST_FACET_PLUGIN_IDS: readonly string[] = ['visual']

/**
 * Refuses a deployment the core cannot judge: the facet write is answered by a
 * registry of `RUST_FACET_PLUGIN_IDS` alone, so a deployment composing a
 * different plugin set would have every write of its own facets accepted
 * unvalidated.
 */
export function refuseFacetCoreForDeployment(deployment: Pick<FacetRegistry, 'plugins'>): void {
  const deploymentPluginIds = deployment.plugins.map((plugin) => plugin.id)
  const same =
    deploymentPluginIds.length === RUST_FACET_PLUGIN_IDS.length &&
    RUST_FACET_PLUGIN_IDS.every((id) => deploymentPluginIds.includes(id))
  if (same) return
  throw new Error(
    `the facet write is judged by the Rust core, whose registry holds only the plugins [${RUST_FACET_PLUGIN_IDS.join(', ')}], and this deployment composes [${deploymentPluginIds.join(', ')}]; its facets would be accepted unvalidated`,
  )
}

/** The `ServerDeps` factory the core serves, over one load. */
export interface CoreLoaders {
  readonly layoutCore: () => Promise<LayoutCore>
}

/**
 * The `ServerDeps.layoutCore` factory: the staged glue and wasm read once, on
 * the first call that asks (or at boot, which shares the one load). The glue
 * is imported by PATH at run time, never bundled, so a build of this package
 * needs no artifact. A load that fails rejects, and the next ask tries again:
 * there is no TypeScript to answer in its place, and a daemon whose boot
 * install succeeded has the instance this shares.
 */
export function coreLoaders(settings: LayoutCoreSettings): CoreLoaders {
  return {
    layoutCore: async () => {
      const core = await loadCoreFrom(artifactDirectory(settings))
      return { routing: core, layout: core, markdown: core, query: core }
    },
  }
}

/**
 * The glue and wasm in `dir`, read once per directory for the whole process,
 * so the install at boot and the lazy routing load share
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

/**
 * Installs the Rust core as this process's OKF and JSON Canvas codecs and its
 * facet write, before anything is served. None has a TypeScript to degrade to,
 * so a daemon that cannot load the artifact refuses to start, naming where it
 * looked, rather than failing its first read of a document. A realm that
 * already installed all three (a test realm) keeps them.
 */
export async function installRustCoresAtBoot(
  settings: LayoutCoreSettings = layoutCoreSettingsFrom(process.env),
): Promise<void> {
  if (okfCoreInstalled() && spatialCoreInstalled() && facetWriteCoreInstalled()) return
  const dir = artifactDirectory(settings)
  try {
    const core = await loadCoreFrom(dir)
    if (!okfCoreInstalled()) installOkfCore(core)
    if (!spatialCoreInstalled()) installSpatialCore(core)
    if (!facetWriteCoreInstalled()) installFacetWriteCore(core)
  } catch (err) {
    throw new Error(
      `the Rust core is required to read and write OKF Markdown and JSON Canvas and to judge a facet write, and did not load from ${dir}; build it with \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\` or point WHITEBOARD_CORE_DIR at a directory holding it`,
      { cause: err },
    )
  }
}
