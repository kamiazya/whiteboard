import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, it } from 'vitest'

import { runE2eCheckpointSmoke } from './mcp-e2e-checkpoint.smoke-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../../..')
const entry = resolve(root, 'dist/server/mcp/index.js')

beforeAll(() => {
  if (!existsSync(entry)) {
    throw new Error(`dist artifact missing: ${entry}\nRun pnpm build before mcp-distribution tests.`)
  }
})

describe('packaged dist smoke', () => {
  it('dist/server/mcp/index.js passes full e2e checkpoint flow', async () => {
    await runE2eCheckpointSmoke({ entry, root })
  }, 60_000)
})
