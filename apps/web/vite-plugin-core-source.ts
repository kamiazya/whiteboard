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
 * Decides whether a build carries the Rust core's wasm, and fails it when the
 * build routes with the core and none is staged.
 *
 * `layout-core.ts` reaches the artifact through one dynamic import of
 * `layout-core-source.ts`, and that module names the staged glue and the
 * `.wasm`. Dead-branch elimination cannot drop it: the bundler resolves
 * every import before it prunes any, so a build without the artifact would
 * fail to resolve it even though nothing could run it. Answering `load`
 * with a stub means the real source is never read, and so its imports are
 * never resolved.
 *
 * Only a build that opted out of the core for routing, OKF AND JSON Canvas
 * (`VITE_WHITEBOARD_CORE=ts`, `VITE_WHITEBOARD_CORE_OKF=ts`, and
 * `VITE_WHITEBOARD_CORE_SPATIAL` unset or `ts`) may be stubbed. A
 * production build routes with `rust` by default, and one that did so without
 * the wasm would ship a stub that degrades every layout to the TypeScript
 * with nothing failing, so it is a build error instead. The dev server is
 * exempt: it falls back to the TypeScript per call and needs no artifact to
 * start. An opted-out build still carries the wasm whenever it is staged, so
 * a rollback is one setting rather than a rebuild of every channel.
 * `WHITEBOARD_SHIP_CORE_WASM=1` (the release jobs) makes an unstaged artifact
 * a build failure for that build too; `0` drops the wasm, which only an
 * opted-out build may ask for. The impl is read with the very function the app
 * decides with at run time. Registered for the page and, through
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
      const settings = coreSettingsFrom(config.env)
      const usesCore = settings.impl !== 'ts' || settings.okf !== 'ts' || settings.spatial !== 'ts'
      const building = config.command === 'build'
      if (ship === '1' && !staged) {
        throw new Error(
          'WHITEBOARD_SHIP_CORE_WASM=1 but packages/core-wasm/artifacts has no wasm; run `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm` first',
        )
      }
      if (building && usesCore && !staged) {
        throw new Error(
          'this build uses the Rust core but packages/core-wasm/artifacts has no wasm; run `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm` first, or set VITE_WHITEBOARD_CORE=ts, VITE_WHITEBOARD_CORE_OKF=ts and VITE_WHITEBOARD_CORE_SPATIAL=ts to build without it',
        )
      }
      if (building && usesCore && ship === '0') {
        throw new Error(
          'WHITEBOARD_SHIP_CORE_WASM=0 leaves the wasm out of a build that uses the Rust core; set VITE_WHITEBOARD_CORE=ts, VITE_WHITEBOARD_CORE_OKF=ts and VITE_WHITEBOARD_CORE_SPATIAL=ts as well',
        )
      }
      const carried = ship === '0' ? false : staged
      stubbed = !usesCore && !carried
    },
    load(id) {
      if (!stubbed || !SOURCE_MODULE.test(id)) return undefined
      return 'export async function loadWebCore() { throw new Error("this build answers in TypeScript and carries no Rust core") }'
    },
  }
}
