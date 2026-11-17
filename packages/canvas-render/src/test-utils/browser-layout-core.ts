import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import wasmUrl from '@kamiazya/whiteboard-core-wasm/wasm?url'
import type { LayoutCore } from '../layout-core.js'

let loading: Promise<LayoutCore> | undefined

/**
 * The Rust core for a test running in a real browser, its staged artifact
 * fetched from where Vite serves it, as the web page loads its own. There is
 * no TypeScript layout to answer in its place (ADR-0054 step 7, S18h), so a
 * realm without the artifact fails its file here, naming the build step.
 * Published as its own subpath, `./test-utils/browser-core`, since the
 * `?url` import is a bundler's.
 */
export function browserLayoutCore(): Promise<LayoutCore> {
  loading ??= (async () => {
    const response = await fetch(wasmUrl)
    if (!response.ok) {
      throw new Error(
        `the core wasm answered ${response.status} from ${wasmUrl}; run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\``,
      )
    }
    const core = await loadCore(await response.arrayBuffer())
    return { routing: core, layout: core, markdown: core, query: core }
  })()
  return loading
}
