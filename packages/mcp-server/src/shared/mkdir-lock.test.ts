import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withMkdirLock } from './mkdir-lock.js'

// A pid that cannot belong to a live process (beyond any OS pid range), so a
// lock seeded with it always reads as held by a dead process.
const DEAD_PID = 2 ** 31 - 1

async function seedOwnedLock(lockDirPath: string, pid: number): Promise<void> {
  await mkdir(lockDirPath, { recursive: false })
  await writeFile(
    join(lockDirPath, 'owner.json'),
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
  )
}

const seedDeadLock = (lockDirPath: string) => seedOwnedLock(lockDirPath, DEAD_PID)

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

  describe('a reclamation that is itself interrupted', () => {
    it('takes a lock whose holder died, even when its break lock was orphaned too', async () => {
      await seedDeadLock(lockPath)
      await seedDeadLock(`${lockPath}.break`)

      let ran = false
      await withMkdirLock(
        lockPath,
        async () => {
          ran = true
        },
        { retryDelayMs: 5, timeoutMs: 3_000 },
      )

      expect(ran).toBe(true)
      expect(await readdir(dir)).toEqual([])
    })

    it('waits out a break lock that has no owner file yet, and takes the lock once it is gone', async () => {
      await seedDeadLock(lockPath)
      await mkdir(`${lockPath}.break`)
      const release = setTimeout(
        () => void rm(`${lockPath}.break`, { recursive: true, force: true }),
        100,
      )

      let ran = false
      try {
        await withMkdirLock(
          lockPath,
          async () => {
            ran = true
          },
          { retryDelayMs: 5, timeoutMs: 3_000 },
        )
      } finally {
        clearTimeout(release)
      }

      expect(ran).toBe(true)
    })

    // A dead holder plus a break lock a live waiter holds is not a lock the
    // caller can ever take; it must hit the deadline, not spin on the reclaim.
    // The timer only bounds how long a regression can spin before it is let
    // go, so the failure names the missing timeout rather than hanging.
    it('gives up at the deadline while a live waiter holds the break lock', async () => {
      await seedDeadLock(lockPath)
      await seedOwnedLock(`${lockPath}.break`, process.pid)
      const letGo = setTimeout(
        () => void rm(`${lockPath}.break`, { recursive: true, force: true }),
        1_000,
      )

      try {
        await expect(
          withMkdirLock(lockPath, async () => {}, { retryDelayMs: 5, timeoutMs: 150 }),
        ).rejects.toThrow(/Lock timeout/)
      } finally {
        clearTimeout(letGo)
      }
    })
  })

  // A holder that died between creating the directory and writing its owner
  // leaves a lock nobody names; past the grace nobody is still writing it.
  describe('a lock whose holder wrote no owner', () => {
    it('is waited on within the grace, and the timeout names the lock directory', async () => {
      await mkdir(lockPath)
      await expect(
        withMkdirLock(lockPath, async () => {}, { retryDelayMs: 5, timeoutMs: 100 }),
      ).rejects.toThrow(lockPath)
    })

    it('is reclaimed once the grace has passed', async () => {
      await mkdir(lockPath)
      const longAgo = new Date(Date.now() - 60_000)
      await utimes(lockPath, longAgo, longAgo)
      let ran = false
      await withMkdirLock(
        lockPath,
        async () => {
          ran = true
        },
        { retryDelayMs: 5, timeoutMs: 1_000 },
      )
      expect(ran).toBe(true)
    })
  })

  it.skipIf(!existsSync('/proc/self/stat'))(
    'reclaims a lock whose pid a later process has taken',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
        stdio: 'ignore',
      })
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        await mkdir(lockPath)
        await writeFile(
          join(lockPath, 'owner.json'),
          // Seconds, not years: a USER_HZ misread still lands within hours.
          JSON.stringify({
            pid: child.pid,
            startedAt: new Date(Date.now() - 30_000).toISOString(),
          }),
        )
        let ran = false
        await withMkdirLock(
          lockPath,
          async () => {
            ran = true
          },
          { retryDelayMs: 5, timeoutMs: 1_000 },
        )
        expect(ran).toBe(true)
      } finally {
        child.kill('SIGKILL')
      }
    },
  )

  // Containers sharing one data volume each number their own processes.
  it('waits out an owner recorded on another host, whatever its pid reads as here', async () => {
    await mkdir(lockPath)
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString(), host: 'another-host' }),
    )
    await expect(
      withMkdirLock(lockPath, async () => {}, { retryDelayMs: 5, timeoutMs: 100 }),
    ).rejects.toThrow('on host another-host')
  })

  it('leaves a lock another holder owns by the time it finishes', async () => {
    const successor = JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() })
    await withMkdirLock(lockPath, async () => {
      await writeFile(join(lockPath, 'owner.json'), successor)
    })
    expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(successor)
  })
})
