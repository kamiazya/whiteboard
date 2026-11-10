import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import wasmUrl from '@kamiazya/whiteboard-core-wasm/wasm?url'
import type { WebCore } from './web-core.js'

/**
 * The Rust core, its wasm fetched from where the bundler serves it and
 * handed to the shim as bytes. The only module that names the artifact;
 * `vite-plugin-core-source.ts` fails a build that has none staged.
 */
export async function loadWebCore(fetchAsset: typeof fetch): Promise<WebCore> {
  const response = await fetchAsset(wasmUrl)
  if (!response.ok) throw new Error(`the core wasm answered ${response.status} from ${wasmUrl}`)
  return loadCore(await response.arrayBuffer())
}
