import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'vitest'

import { runPackedTarballSmoke } from './tarball.distribution-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../../..')
const repoRoot = resolve(packageRoot, '../..')

describe('packed tarball smoke', () => {
  it('npm pack → pnpm install → installed entry passes full e2e checkpoint flow', async () => {
    await runPackedTarballSmoke({ packageRoot, repoRoot })
  }, 120_000)
})
