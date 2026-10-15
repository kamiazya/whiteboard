// An owner write that fails after a successor already holds the lock path: a
// write stalled past the unwritten grace lets a waiter reclaim the directory
// and take it, so the failing holder must not clean up a directory that may no
// longer be its own. Mocked, because a real stalled write cannot be timed.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const successorOwner = JSON.stringify({ pid: 1, startedAt: new Date(0).toISOString() })

const stall = vi.hoisted(() => ({ armed: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const path = String(args[0])
      if (!stall.armed || !path.endsWith('owner.json')) return actual.writeFile(...args)
      stall.armed = false
      // While this write stalled, a waiter reclaimed the directory and took it.
      const lockDir = path.slice(0, -'/owner.json'.length)
      await actual.rm(lockDir, { recursive: true, force: true })
      await actual.mkdir(lockDir)
      await actual.writeFile(path, successorOwner)
      throw Object.assign(new Error('owner write failed'), { code: 'EIO' })
    }),
  }
})

const { withMkdirLock } = await import('./mkdir-lock.js')

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mkdir-lock-owner-write-'))
  lockPath = join(dir, 'store.lock')
})
afterEach(async () => {
  stall.armed = false
  await rm(dir, { recursive: true, force: true })
})

describe('an owner write that fails', () => {
  it("leaves the lock directory alone, so a successor's lock survives", async () => {
    stall.armed = true
    await mkdir(dir, { recursive: true })

    await expect(withMkdirLock(lockPath, async () => {}, { timeoutMs: 1_000 })).rejects.toThrow(
      'owner write failed',
    )

    expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(successorOwner)
  })
})
