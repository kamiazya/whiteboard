import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { withMkdirLock } from './mkdir-lock.js'

// A pid that cannot belong to a live process (beyond any OS pid range), so a
// lock seeded with it always reads as held by a dead process.
const DEAD_PID = 2 ** 31 - 1

async function seedDeadLock(lockDirPath: string): Promise<void> {
  await mkdir(lockDirPath, { recursive: false })
  await writeFile(
    join(lockDirPath, 'owner.json'),
    JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }),
  )
}

describe('withMkdirLock', () => {
  let dir: string
  let lockPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mkdir-lock-test-'))
    lockPath = join(dir, 'store.lock')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('serializes concurrent critical sections', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const order: number[] = []

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        withMkdirLock(lockPath, async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 10))
          order.push(i)
          inFlight -= 1
        }),
      ),
    )

    expect(maxInFlight).toBe(1)
    expect(order).toHaveLength(4)
  })

  it('reclaims a lock whose recorded pid is dead', async () => {
    await seedDeadLock(lockPath)

    let ran = false
    await withMkdirLock(
      lockPath,
      async () => {
        ran = true
      },
      { retryDelayMs: 5, timeoutMs: 2_000 },
    )

    expect(ran).toBe(true)
  })

  it('never overlaps critical sections when several waiters race to reclaim a dead lock', async () => {
    await seedDeadLock(lockPath)

    let inFlight = 0
    let maxInFlight = 0

    await Promise.all(
      Array.from({ length: 4 }, () =>
        withMkdirLock(
          lockPath,
          async () => {
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 10))
            inFlight -= 1
          },
          { retryDelayMs: 5, timeoutMs: 5_000 },
        ),
      ),
    )

    expect(maxInFlight).toBe(1)
  })

  it('leaves no stale lock or tombstone behind after reclamation', async () => {
    await seedDeadLock(lockPath)

    await withMkdirLock(lockPath, async () => {}, { retryDelayMs: 5, timeoutMs: 2_000 })

    expect(await readdir(dir)).toEqual([])
  })
})
