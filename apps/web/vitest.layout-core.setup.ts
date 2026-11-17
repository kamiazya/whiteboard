import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import wasmUrl from '@kamiazya/whiteboard-core-wasm/wasm?url'
import { startLayoutCore } from './src/lib/page-layout-core.js'

/**
 * A jsdom realm boots the Rust core the way the page does (ADR-0054 step 7):
 * there is no TypeScript layout to answer in its place since S18h. Only where
 * the bytes come from differs — the page fetches the artifact Vite serves, and
 * a jsdom realm has no server — so `fetch` answers that one URL from the staged
 * artifact on disk and passes every other request through.
 *
 * It answers through `fetch` rather than by mocking the source module, so a
 * test that stubs `fetch` and starts a fresh realm (`vi.resetModules`) gets
 * the realm it describes: a stalled or failing load, the `core-unavailable`
 * path. A mock would outlive the reset and load the core regardless.
 *
 * Outside `src/` because it reads the artifact with `node:*`, which the
 * browser app's source may not import (`web-app-boundary.test.ts`).
 */
const artifact = readFileSync(
  fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm')),
)
const platformFetch = globalThis.fetch?.bind(globalThis)
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === wasmUrl) {
    init?.signal?.throwIfAborted()
    return Promise.resolve(
      new Response(artifact, { headers: { 'content-type': 'application/wasm' } }),
    )
  }
  return platformFetch(input, init)
}) as typeof fetch

await startLayoutCore()
