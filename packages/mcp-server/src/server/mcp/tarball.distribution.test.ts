import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assertTarballFileList, runPackedTarballSmoke } from './tarball.distribution-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../../..')
const repoRoot = resolve(packageRoot, '../..')

describe('packed tarball smoke', () => {
  it('npm pack → pnpm install → installed entry passes full e2e checkpoint flow', async () => {
    await runPackedTarballSmoke({ packageRoot, repoRoot })
  }, 120_000)
})

describe('assertTarballFileList', () => {
  const validEntries = [
    'package/package.json',
    'package/dist/server/mcp/index.js',
    'package/dist/web-app/index.html',
  ]

  it('passes when dist/web-app/index.html is present and no dist/app/ entries exist', () => {
    expect(() => assertTarballFileList(validEntries)).not.toThrow()
  })

  it('throws when the retired dist/app/ output reappears in the tarball', () => {
    const entries = [...validEntries, 'package/dist/app/index.html', 'package/dist/app/main.js']

    expect(() => assertTarballFileList(entries)).toThrow(
      /retired dist\/app\/ entries.*package\/dist\/app\/index\.html.*package\/dist\/app\/main\.js/s,
    )
  })

  it('throws when dist/web-app/index.html is missing', () => {
    const entries = validEntries.filter((e) => e !== 'package/dist/web-app/index.html')

    expect(() => assertTarballFileList(entries)).toThrow(/missing dist\/web-app\/index\.html/)
  })
})
