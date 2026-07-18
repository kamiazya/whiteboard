// Cross-process mutual exclusion built on `mkdir()`'s atomic guarantee: a
// second process racing to create the same directory gets EEXIST, so
// whichever process wins the mkdir is the sole lock holder. No external
// lockfile dependency needed.
//
// A lock left behind by a holder that has since died (crashed daemon,
// killed CLI) would otherwise wedge every future acquirer forever, so the
// holder's pid is recorded alongside the lock and a waiter reclaims the
// lock once that pid is no longer alive.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isPidAlive } from '../daemon/daemon-registry.js'

const LOCK_OWNER_FILENAME = 'owner.json'

const lockOwnerSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
})

type LockOwner = z.infer<typeof lockOwnerSchema>

async function writeOwnerMetadata(lockDirPath: string): Promise<void> {
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString() }
  await writeFile(join(lockDirPath, LOCK_OWNER_FILENAME), JSON.stringify(owner, null, 2))
}

async function loadOwnerMetadata(lockDirPath: string): Promise<LockOwner | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(lockDirPath, LOCK_OWNER_FILENAME), 'utf-8'))
    const result = lockOwnerSchema.safeParse(raw)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export interface MkdirLockOptions {
  retryDelayMs?: number
  timeoutMs?: number
}

// Runs `fn` while holding the exclusive lock at `lockDirPath`. Callers must
// ensure the lock's parent directory already exists. Waits (polling every
// `retryDelayMs`) for a concurrent holder to release, reclaiming the lock
// early if that holder's recorded pid is dead, and gives up after
// `timeoutMs`.
export async function withMkdirLock<T>(
  lockDirPath: string,
  fn: () => Promise<T>,
  options: MkdirLockOptions = {},
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 50
  const timeoutMs = options.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      await mkdir(lockDirPath, { recursive: false })
      await writeOwnerMetadata(lockDirPath)
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw err
      }
      const owner = await loadOwnerMetadata(lockDirPath)
      if (owner && !isPidAlive(owner.pid)) {
        await rm(lockDirPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Lock timeout waiting for: ${lockDirPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDirPath, { recursive: true, force: true })
  }
}
