import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * codec's `parseSpatial`, with the Rust core installed in this realm first —
 * JSON Canvas text has no TypeScript reader, so the eval reads what a model
 * drew the way the daemon does. Loaded the way the codec's own test setup
 * loads it: the staged artifact, through core-wasm's loader.
 *
 * Dynamic imports, because these are TypeScript sources and the runner
 * registers the tsx loader after its static imports resolve (see
 * `tasks.mjs`'s `workspacePackages`).
 */
export async function loadSpatialReader() {
  const codec = await import('@kamiazya/whiteboard-codec')
  if (!codec.spatialCoreInstalled()) {
    const { loadCore } = await import('@kamiazya/whiteboard-core-wasm/load')
    const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
    codec.installSpatialCore(await loadCore(readFileSync(artifact)))
  }
  return codec.parseSpatial
}
