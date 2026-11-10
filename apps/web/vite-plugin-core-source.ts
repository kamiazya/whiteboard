import { existsSync } from 'node:fs'
import type { Plugin } from 'vite'

const STAGED_WASM = new URL(
  '../../packages/core-wasm/artifacts/whiteboard_wasm_bg.wasm',
  import.meta.url,
)

export interface CoreSourceOptions {
  /** Whether the Rust core's wasm is staged in this checkout. */
  readonly artifactStaged?: () => boolean
  /** `WHITEBOARD_SHIP_CORE_WASM`: `1` names a release build, `0` asks to leave the wasm out, which no build may. */
  readonly ship?: string | undefined
}

/**
 * Fails a build that would ship without the Rust core's wasm.
 *
 * The page reads and writes OKF Markdown only through the core (its
 * TypeScript is deleted), and `layout-core.ts` reaches the artifact through
 * one dynamic import of `layout-core-source.ts`, which names the staged glue
 * and the `.wasm`. A build with no wasm would resolve nothing there and ship a
 * page that cannot import or download a note, so it is a build error instead,
 * naming the step that stages it. `WHITEBOARD_SHIP_CORE_WASM=0` asks for
 * exactly that build and is refused for the same reason. The dev server is
 * exempt: it needs no artifact to start, and the page fails loudly at its
 * first OKF use when the wasm is absent. Registered for the page and, through
 * `worker.plugins`, for the layout worker's own bundle: each has its own graph.
 */
export function coreSourcePlugin(options: CoreSourceOptions = {}): Plugin {
  const artifactStaged = options.artifactStaged ?? (() => existsSync(STAGED_WASM))
  const ship = 'ship' in options ? options.ship : process.env.WHITEBOARD_SHIP_CORE_WASM
  return {
    name: 'core-wasm-required',
    configResolved(config) {
      if (config.command !== 'build') return
      if (ship === '0') {
        throw new Error(
          'WHITEBOARD_SHIP_CORE_WASM=0 leaves the wasm out of a build whose page reads and writes OKF through it; unset it',
        )
      }
      if (!artifactStaged()) {
        throw new Error(
          'this build needs the Rust core but packages/core-wasm/artifacts has no wasm; run `pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm` first',
        )
      }
    },
  }
}
