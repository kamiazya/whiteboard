import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { runE2eCheckpointSmoke } from './mcp-e2e-checkpoint.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = resolve(root, 'src/server/mcp/index.ts')

describe('e2e version smoke', () => {
  it('full MCP stdio flow: wb_canvas_create → facet_set → version_save → version_list → version_restore', async () => {
    await runE2eCheckpointSmoke({ entry, root })
  }, 60_000)
})
