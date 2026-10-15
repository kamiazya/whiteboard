// A data directory that refuses the lock's create. Mocked, because a real
// read-only directory does not refuse root, and the suite runs as root on CI.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../../log.js'

const openError = vi.hoisted(() => ({ code: 'EACCES' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(async () => {
      throw Object.assign(new Error(`create refused (${openError.code})`), {
        code: openError.code,
      })
    }),
  }
})

const { withMigrationLock } = await import('./migration-lock.js')

let dataDir: string
let logs: ReturnType<typeof captureLogsForTests>

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-migration-lock-create-'))
  logs = captureLogsForTests('warning')
})
afterEach(async () => {
  logs.restore()
  await rm(dataDir, { recursive: true, force: true })
})

describe('a data directory that refuses the migration lock', () => {
  it.each(['EACCES', 'EPERM', 'EROFS'])('migrates without the lock on %s', async (code) => {
    openError.code = code
    const work = vi.fn(async () => 'done')
    await expect(withMigrationLock(dataDir, work, { timeoutMs: 500, pollMs: 10 })).resolves.toBe(
      'done',
    )
    expect(work).toHaveBeenCalledOnce()
  })

  it('fails rather than migrating unlocked on an error that does not rule the lock out', async () => {
    openError.code = 'EIO'
    const work = vi.fn(async () => 'done')
    await expect(
      withMigrationLock(dataDir, work, { timeoutMs: 500, pollMs: 10 }),
    ).rejects.toMatchObject({ code: 'EIO' })
    expect(work).not.toHaveBeenCalled()
  })
})
