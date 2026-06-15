import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'vitest'

import { runCodexConfigSmoke } from './codex-config.distribution-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../../..')
const repoRoot = resolve(packageRoot, '../..')

describe('codex-config smoke', () => {
  it('plugin manifest + published mcp config are valid, and packaged entry starts', async () => {
    await runCodexConfigSmoke({ packageRoot, repoRoot })
  }, 120_000)
})
