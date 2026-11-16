import { vi } from 'vitest'

/**
 * A jsdom realm boots the Rust core the way the page does (ADR-0054 step 7):
 * there is no TypeScript layout to answer in its place since S18h. Only where
 * the bytes come from differs — the page fetches the artifact Vite serves,
 * and a jsdom realm has no server, so it reads the staged artifact from disk.
 */
vi.mock('../lib/spatial/layout-core-source.js', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { loadCore } = await import('@kamiazya/whiteboard-core-wasm/load')
  const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
  return { loadWebCore: async () => loadCore(readFileSync(artifact)) }
})

const { startLayoutCore } = await import('../lib/page-layout-core.js')
await startLayoutCore()
