import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { runStdioExitSmoke } from './stdio-exit.smoke-impl.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = resolve(root, 'src/server/mcp/index.ts')

describe('stdio exit smoke', () => {
  it('exits promptly when stdin is closed (parent disconnect)', async () => {
    await runStdioExitSmoke({ entry, root, trigger: 'stdin-end' })
  }, 15_000)

  it('exits promptly on SIGTERM', async () => {
    await runStdioExitSmoke({ entry, root, trigger: 'SIGTERM' })
  }, 15_000)

  it('exits promptly on SIGINT', async () => {
    await runStdioExitSmoke({ entry, root, trigger: 'SIGINT' })
  }, 15_000)
})
