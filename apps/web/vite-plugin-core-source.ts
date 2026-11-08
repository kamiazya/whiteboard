import type { Plugin } from 'vite'
import { coreSettingsFrom } from './src/lib/spatial/layout-core-settings.js'

const SOURCE_MODULE = /\/src\/lib\/spatial\/layout-core-source\.ts(\?.*)?$/

/**
 * Keeps the Rust core's wasm out of a build that routes in TypeScript.
 *
 * `layout-core.ts` reaches the artifact through one dynamic import of
 * `layout-core-source.ts`, and that module names the staged glue and the
 * `.wasm`. Dead-branch elimination cannot drop it: the bundler resolves
 * every import before it prunes any, so a build without the artifact would
 * fail to resolve it even though nothing could run it. Answering `load`
 * with a stub means the real source is never read, and so its imports are
 * never resolved.
 *
 * It decides from the resolved config's env with the very function the app
 * decides with at run time, so the build drops the core exactly when the app
 * would not have loaded it. Registered for the page and, through
 * `worker.plugins`, for the layout worker's own bundle: each has its own graph.
 */
export function coreSourcePlugin(): Plugin {
  let stubbed = false
  return {
    name: 'core-source-stub',
    enforce: 'pre',
    configResolved(config) {
      stubbed = coreSettingsFrom(config.env).impl === 'ts'
    },
    load(id) {
      if (!stubbed || !SOURCE_MODULE.test(id)) return undefined
      return 'export async function loadWebCore() { throw new Error("this build routes edges in TypeScript and carries no Rust core") }'
    },
  }
}
