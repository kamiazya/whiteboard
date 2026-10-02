import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'vitest'
import { repoRoot } from '../../shared/test-utils/repo-root.js'
import { runCodexConfigSmoke } from './codex-config.distribution-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../../..')
const REPO_ROOT = repoRoot()

describe('codex-config smoke', () => {
  it('plugin manifest + published mcp config are valid, and packaged entry starts', async () => {
    await runCodexConfigSmoke({ packageRoot, repoRoot: REPO_ROOT })
  }, 120_000)
})
