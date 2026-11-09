import { existsSync } from 'node:fs'
import type { Plugin } from 'vite'
import { coreSettingsFrom } from './src/lib/spatial/layout-core-settings.js'

const SOURCE_MODULE = /\/src\/lib\/spatial\/layout-core-source\.ts(\?.*)?$/

const STAGED_WASM = new URL(
  '../../packages/core-wasm/artifacts/whiteboard_wasm_bg.wasm',
  import.meta.url,
)

export interface CoreSourceOptions {
  /** Whether the Rust core's wasm is staged in this checkout. */
  readonly artifactStaged?: () => boolean
  /** `WHITEBOARD_SHIP_CORE_WASM`: `1` requires the wasm in the build, `0` leaves it out. */
  readonly ship?: string | undefined
}

/**
 * Keeps the Rust core's wasm out of a build that neither routes with it nor
 * carries it.
 *
 * `layout-core.ts` reaches the artifact through one dynamic import of
 * `layout-core-source.ts`, and that module names the staged glue and the
 * `.wasm`. Dead-branch elimination cannot drop it: the bundler resolves
 * every import before it prunes any, so a build without the artifact would
 * fail to resolve it even though nothing could run it. Answering `load`
 * with a stub means the real source is never read, and so its imports are
 * never resolved.
 *
 * A build routing in TypeScript still carries the wasm whenever it is
 * staged: a release ships the artifact before anything defaults to it, so the
 * switch is one setting rather than a rebuild of every channel.
 * `WHITEBOARD_SHIP_CORE_WASM=1` (the release jobs) makes an unstaged artifact
 * a build failure instead of a quiet omission; `0` drops it regardless. The
 * impl is read with the very function the app decides with at run time. Registered for the page and, through
 * `worker.plugins`, for the layout worker's own bundle: each has its own graph.
 */
export function coreSourcePlugin(options: CoreSourceOptions = {}): Plugin {
  const artifactStaged = options.artifactStaged ?? (() => existsSync(STAGED_WASM))
  const ship = 'ship' in options ? options.ship : process.env.WHITEBOARD_SHIP_CORE_WASM
  let stubbed = false
  return {
    name: 'core-source-stub',
    enforce: 'pre',
    configResolved(config) {
      const staged = artifactStaged()
      if (ship === '1' && !staged) {
        throw new Error(
          'WHITEBOARD_SHIP_CORE_WASM=1 but packages/core-wasm/artifacts has no wasm; run `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm` first',
        )
      }
      const carried = ship === '0' ? false : staged
      stubbed = coreSettingsFrom(config.env).impl === 'ts' && !carried
    },
    load(id) {
      if (!stubbed || !SOURCE_MODULE.test(id)) return undefined
      return 'export async function loadWebCore() { throw new Error("this build routes edges in TypeScript and carries no Rust core") }'
    },
  }
}
