import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assertTarballFileList,
  buildTarballSmokeChildEnv,
  runPackedTarballSmoke,
} from './tarball.distribution-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '../../..')
const repoRoot = resolve(packageRoot, '../..')

describe('packed tarball smoke', () => {
  it('npm pack → pnpm install → installed entry passes full e2e checkpoint flow', async () => {
    await runPackedTarballSmoke({ packageRoot, repoRoot })
  }, 120_000)

  // Regression for the release-blocking "Daemon startup timeout" failure: a
  // CI job env block that sets WHITEBOARD_DEV=1 for its src-mode checks must
  // not make this smoke spawn the installed (dist-only) daemon in watch mode.
  it('succeeds even when the ambient env carries WHITEBOARD_DEV=1', async () => {
    const originalDev = process.env.WHITEBOARD_DEV
    process.env.WHITEBOARD_DEV = '1'
    try {
      await runPackedTarballSmoke({ packageRoot, repoRoot })
    } finally {
      if (originalDev === undefined) delete process.env.WHITEBOARD_DEV
      else process.env.WHITEBOARD_DEV = originalDev
    }
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

describe('buildTarballSmokeChildEnv', () => {
  it('strips WHITEBOARD_DEV so the packaged entry never spawns the daemon in watch mode', () => {
    const processEnv = { PATH: '/usr/bin', WHITEBOARD_DEV: '1' }

    const childEnv = buildTarballSmokeChildEnv(processEnv)

    expect(childEnv.WHITEBOARD_DEV).toBeUndefined()
    expect(childEnv.PATH).toBe('/usr/bin')
  })

  it('is a no-op when WHITEBOARD_DEV is already absent from the parent env', () => {
    const processEnv = { PATH: '/usr/bin' }

    const childEnv = buildTarballSmokeChildEnv(processEnv)

    expect(childEnv).toEqual({ PATH: '/usr/bin' })
  })

  it('does not mutate the input env object', () => {
    const processEnv = { WHITEBOARD_DEV: '1' }

    buildTarballSmokeChildEnv(processEnv)

    expect(processEnv.WHITEBOARD_DEV).toBe('1')
  })
})
