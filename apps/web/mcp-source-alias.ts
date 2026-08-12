import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const src = (file: string) => resolve(here, '../../packages/mcp-server/src/shared', file)

/**
 * mcp-server subpaths resolved to SOURCE rather than to `dist`, so `pnpm dev`
 * and the test run work before anything is built.
 *
 * Shared by vite.config.ts, vitest.config.ts, vitest.browser.config.ts, and
 * vitest.docs-snapshots.config.ts because keeping separate copies in step is
 * not something any one file can enforce: a subpath added to only one of them
 * resolves through the package export map instead, which silently finds a
 * stale `dist` on a machine that has built once and fails outright on a
 * clean checkout — so the miss surfaces in CI rather than locally. Each
 * config still adds its own entries on top (test-only subpaths, canvas-viewer,
 * '@docs-assets'). mcp-source-alias-coverage.test.ts pins that every config
 * spreads this map rather than re-copying it.
 */
export const mcpSourceAlias: Record<string, string> = {
  '@kamiazya/whiteboard-mcp/browser-shared': src('browser-shared-index.ts'),
  '@kamiazya/whiteboard-mcp/daemon-backend': src('daemon-backend.ts'),
  '@kamiazya/whiteboard-mcp/api-client': src('api-client.ts'),
  '@kamiazya/whiteboard-mcp/sse-backend': src('sse-backend.ts'),
  // The SharedWorker imports this, and a worker is bundled in its own pass
  // that resolves the export map rather than any dist a previous local build
  // happened to leave behind.
  '@kamiazya/whiteboard-mcp/sse-stream-hub': src('sse-stream-hub.ts'),
  '@kamiazya/whiteboard-mcp/select-canvas-transport': src('select-canvas-transport.ts'),
  '@kamiazya/whiteboard-mcp/api-contracts': src('api-contracts/index.ts'),
}
