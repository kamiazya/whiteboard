import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pathExists } from '../../../shared/test-utils/path-exists.js'
import { captureLogsForTests } from '../../log.js'
import { MIGRATION_LOCK_FILENAME, withMigrationLock } from './migration-lock.js'

// Reading a process's start time is how a reused pid is told apart, and only
// /proc answers it; elsewhere a live pid is always taken for the holder.
const CAN_READ_PROCESS_START = existsSync('/proc/self/stat')

let dataDir: string
let lockPath: string
let logs: ReturnType<typeof captureLogsForTests>
const children: ChildProcess[] = []

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-migration-lock-'))
  lockPath = join(dataDir, MIGRATION_LOCK_FILENAME)
  logs = captureLogsForTests('info')
})
afterEach(async () => {
  logs.restore()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await rm(dataDir, { recursive: true, force: true })
})

function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', ''])
  if (pid === undefined) throw new Error('could not spawn a process to take a pid from')
  return pid
}

async function liveUnrelatedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('spawned process has no pid')
  return child.pid
}

// The text this build writes: the holder's pid, then the host it ran on.
const lockText = (pid: number): string => `${pid}\n${hostname()}`

async function backdate(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms)
  await utimes(path, when, when)
}

describe('withMigrationLock', () => {
  it('holds the lock file, naming this process, while the work runs', async () => {
    const seen = await withMigrationLock(dataDir, async () => readFile(lockPath, 'utf8'))
    expect(seen).toBe(`${process.pid}\n${hostname()}`)
    expect(await pathExists(lockPath)).toBe(false)
  })

  it('releases the lock when the work throws', async () => {
    await expect(
      withMigrationLock(dataDir, async () => {
        throw new Error('migration failed')
      }),
    ).rejects.toThrow('migration failed')
    expect(await pathExists(lockPath)).toBe(false)
  })

  it('replaces a lock whose holder has exited', async () => {
    const holder = deadPid()
    await writeFile(lockPath, lockText(holder))
    let ran = false
    await withMigrationLock(dataDir, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ holderPid: holder, reason: 'holder exited' }),
      }),
    )
  })

  // A lock left by a build that recorded no host is judged by its pid alone.
  it('replaces a lock naming only the pid of a holder that has exited', async () => {
    await writeFile(lockPath, String(deadPid()))
    let ran = false
    await withMigrationLock(dataDir, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it.skipIf(!CAN_READ_PROCESS_START)(
    'replaces a lock whose pid a later process has taken',
    async () => {
      const reused = await liveUnrelatedPid()
      await writeFile(lockPath, lockText(reused))
      // Seconds, not hours: a host up for less than the backdate (a CI
      // runner) would start every process after it, and prove nothing.
      await backdate(lockPath, 30_000)
      let ran = false
      await withMigrationLock(
        dataDir,
        async () => {
          ran = true
        },
        { timeoutMs: 1_000 },
      )
      expect(ran).toBe(true)
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            holderPid: reused,
            reason: 'holder pid reused by a later process',
          }),
        }),
      )
    },
  )

  it('waits out a live holder, then names it when the bound passes', async () => {
    const holder = await liveUnrelatedPid()
    await writeFile(lockPath, lockText(holder))
    let ran = false
    await expect(
      withMigrationLock(
        dataDir,
        async () => {
          ran = true
        },
        { timeoutMs: 200, pollMs: 10 },
      ),
    ).rejects.toThrow(`waiting for process ${holder} to finish migrating`)
    expect(ran).toBe(false)
    expect(await readFile(lockPath, 'utf8')).toBe(lockText(holder))
  })

  it('treats an empty lock as a holder still writing its pid, within the grace', async () => {
    await writeFile(lockPath, '')
    await expect(
      withMigrationLock(dataDir, async () => {}, { timeoutMs: 100, pollMs: 10 }),
    ).rejects.toThrow('waiting for process (unknown)')
  })

  it('replaces an empty lock once the grace has passed', async () => {
    await writeFile(lockPath, '')
    await backdate(lockPath, 60_000)
    let ran = false
    await withMigrationLock(
      dataDir,
      async () => {
        ran = true
      },
      { timeoutMs: 1_000 },
    )
    expect(ran).toBe(true)
  })

  it('leaves a lock that no longer names this process when it finishes', async () => {
    const successor = await liveUnrelatedPid()
    await withMigrationLock(dataDir, async () => {
      await writeFile(lockPath, String(successor))
    })
    expect(await readFile(lockPath, 'utf8')).toBe(String(successor))
  })

  // Containers sharing one data volume each number their own processes, and
  // each runs as pid 1: another host's pid says nothing here.
  it('waits out a holder recorded on another host, whatever its pid reads as here', async () => {
    await writeFile(lockPath, `${deadPid()}\nanother-host`)
    await expect(
      withMigrationLock(dataDir, async () => {}, { timeoutMs: 150, pollMs: 10 }),
    ).rejects.toThrow('on host another-host')
    expect(await readFile(lockPath, 'utf8')).toContain('another-host')
  })

  // Every container's server is pid 1, so a lock naming this pid may be
  // another container's.
  it('leaves a lock that names its pid but not its host when it finishes', async () => {
    const elsewhere = String(process.pid)
    await withMigrationLock(dataDir, async () => {
      await writeFile(lockPath, elsewhere)
    })
    expect(await readFile(lockPath, 'utf8')).toBe(elsewhere)
  })

  // The default log level is `warning`; a wait announced below it leaves a
  // caller that gives up first looking at an empty log.
  it('announces a wait at the default log level, naming the holder, lock and deadline', async () => {
    const warnings = captureLogsForTests('warning')
    try {
      const holder = await liveUnrelatedPid()
      await writeFile(lockPath, String(holder))
      await expect(
        withMigrationLock(dataDir, async () => {}, { timeoutMs: 100, pollMs: 10 }),
      ).rejects.toThrow()
      expect(warnings.records).toContainEqual(
        expect.objectContaining({
          level: 'warning',
          data: expect.objectContaining({
            holderPid: holder,
            lockPath,
            deadline: expect.any(String),
          }),
        }),
      )
    } finally {
      warnings.restore()
    }
  })
})
