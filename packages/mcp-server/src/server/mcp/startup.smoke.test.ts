import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'vitest'

import { runStartupSmoke } from './startup.smoke-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../../..')
const entry = resolve(root, 'src/server/mcp/index.ts')

describe('startup smoke', () => {
  it('MCP server starts without fatal errors and stays alive for 3s', async () => {
    await runStartupSmoke({ entry, root })
  }, 10_000)
})
