#!/usr/bin/env node
// Direct invocation requires tsx:
//   node --import tsx/esm scripts/mcp-smoke.mjs
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const entry = resolve(root, 'src/server/mcp/index.ts')

try {
  const { runStartupSmoke } = await import(resolve(root, 'src/server/mcp/startup.smoke-impl.ts'))
  await runStartupSmoke({ entry, root })
} catch (err) {
  console.error(`[mcp-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
