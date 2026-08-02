import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../server/log.js'
import { purgeLegacyWebOriginTrustFile } from './purge-legacy-trust-file.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-purge-legacy-trust-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('purgeLegacyWebOriginTrustFile', () => {
  it('removes trusted-web-origins.json when present', async () => {
    const filePath = join(dataDir, 'trusted-web-origins.json')
    await writeFile(filePath, '{"schemaVersion":2,"origins":[]}')

    await purgeLegacyWebOriginTrustFile(dataDir)

    await expect(readFile(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is silent and succeeds when the file is absent (ENOENT swallowed)', async () => {
    const handle = captureLogsForTests()
    try {
      await expect(purgeLegacyWebOriginTrustFile(dataDir)).resolves.toBeUndefined()
      expect(handle.records).toEqual([])
    } finally {
      handle.restore()
    }
  })

  it('still resolves and logs exactly one warning when removal fails for a non-ENOENT reason', async () => {
    const handle = captureLogsForTests()
    try {
      const nonEnoentError = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      })
      // Only the main trust file's removal fails; the sibling lock dir does
      // not exist in this fixture, so its removal takes the real,
      // ENOENT-swallowing path and must not add a second warning.
      await expect(
        purgeLegacyWebOriginTrustFile(dataDir, {
          rm: async (path, options) => {
            if (String(path).endsWith('trusted-web-origins.json')) {
              throw nonEnoentError
            }
            return rm(path, options)
          },
        }),
      ).resolves.toBeUndefined()

      const warnings = handle.records.filter((r) => r.level === 'warning')
      expect(warnings).toHaveLength(1)
    } finally {
      handle.restore()
    }
  })

  it('is idempotent: a second call after removal takes the silent ENOENT path', async () => {
    const filePath = join(dataDir, 'trusted-web-origins.json')
    await writeFile(filePath, '{"schemaVersion":2,"origins":[]}')

    await purgeLegacyWebOriginTrustFile(dataDir)

    const handle = captureLogsForTests()
    try {
      await expect(purgeLegacyWebOriginTrustFile(dataDir)).resolves.toBeUndefined()
      expect(handle.records).toEqual([])
    } finally {
      handle.restore()
    }
  })

  it('also removes the sibling lock dir, best-effort', async () => {
    const lockDir = join(dataDir, 'trusted-web-origins.lock')
    await mkdir(lockDir)

    await purgeLegacyWebOriginTrustFile(dataDir)

    await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
