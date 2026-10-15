// A stale lock this process cannot move aside: the directory refuses the rename
// while the lock file itself is still there to be read. Mocked, because a real
// read-only directory does not refuse root, and the suite runs as root on CI.
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../../log.js'

const renameError = vi.hoisted(() => ({ code: 'EACCES' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async () => {
      throw Object.assign(new Error(`rename refused (${renameError.code})`), {
        code: renameError.code,
      })
    }),
  }
})

const { MIGRATION_LOCK_FILENAME, withMigrationLock } = await import('./migration-lock.js')

let dataDir: string
let logs: ReturnType<typeof captureLogsForTests>

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-migration-lock-rename-'))
  logs = captureLogsForTests('info')
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  if (pid === undefined) throw new Error('could not spawn a process to take a pid from')
  await writeFile(join(dataDir, MIGRATION_LOCK_FILENAME), String(pid))
})
afterEach(async () => {
  logs.restore()
  await rm(dataDir, { recursive: true, force: true })
})

describe('a stale migration lock that cannot be moved aside', () => {
  it.each([
    'EACCES',
    'EPERM',
    'EROFS',
  ])('migrates without the lock when the rename is refused with %s', async (code) => {
    renameError.code = code
    const work = vi.fn(async () => 'done')
    await expect(withMigrationLock(dataDir, work, { timeoutMs: 1_000, pollMs: 10 })).resolves.toBe(
      'done',
    )
    expect(work).toHaveBeenCalledOnce()
  })

  it('fails rather than migrating unlocked on an error that does not rule the lock out', async () => {
    renameError.code = 'EIO'
    const work = vi.fn(async () => 'done')
    await expect(
      withMigrationLock(dataDir, work, { timeoutMs: 1_000, pollMs: 10 }),
    ).rejects.toMatchObject({ code: 'EIO' })
    expect(work).not.toHaveBeenCalled()
  })
})
