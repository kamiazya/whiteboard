import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureLoopAvailability } from '../../../shared/test-utils/loop-availability.js'
import { acquireLease } from '../lease.js'
import { busyRetryingDialect } from './busy-retry.js'
import { closeDb, DB_FILENAME, getDb } from './index.js'
import { clearPrepareCache, prepareDataDir } from './prepare.js'
import type { DatabaseSchema } from './schema.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

// The other process: opens the same file the way a second daemon or the stdio
// agent does, takes the write lock, says so, and holds it until told to let go.
// Released by a message rather than a timer so the test decides when contention
// ends and nothing here waits on the clock to find out.
const HOLDER = `
import { createClient } from '@libsql/client'
import { createInterface } from 'node:readline'
const client = createClient({ url: process.argv[1] })
const tx = await client.transaction('write')
await tx.execute({ sql: "insert into leases (name, holder, expiresAt) values ('held', 'other', 1)", args: [] })
console.log('held')
for await (const _ of createInterface({ input: process.stdin })) break
await tx.commit()
client.close()
`

interface Holder {
  release(): Promise<void>
}

async function holdWriteLock(dataDir: string): Promise<Holder> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', HOLDER, `file:${join(dataDir, DB_FILENAME)}`],
    { cwd: packageRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`holder exited with ${code}`)),
    )
  })
  exited.catch(() => {})
  const lines = createInterface({ input: child.stdout })
  let held = false
  for await (const line of lines) {
    if (line === 'held') {
      held = true
      break
    }
  }
  lines.close()
  if (!held) throw new Error('holder exited before taking the write lock')
  return {
    async release() {
      child.stdin.end('release\n')
      await exited
    },
  }
}

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-write-contention-'))
  await prepareDataDir(dataDir)
})
afterEach(async () => {
  await closeDb(dataDir)
  clearPrepareCache()
  await rm(dataDir, { recursive: true, force: true })
})

/** Settles with 'pending' if `work` has not finished within `ms`. */
async function stillPendingAfter(work: Promise<unknown>, ms: number): Promise<boolean> {
  const pending = Symbol('pending')
  const first = await Promise.race([
    work.then(() => 'settled' as const),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms)),
  ])
  return first === pending
}

const lease = { name: 'backup', holder: 'me', ttlMs: 60_000, nowMs: 1 }

/**
 * Cost: one child process per test, 0.3-0.5s of wall clock each.
 *
 * The stdio agent and the daemon are two processes over one data directory, so
 * the second writer to arrive meets a lock the first holds. The handle's
 * busy_timeout is 0 (a longer one blocks the event loop for its whole
 * duration, which the last case here measures), so without the store waiting
 * for it that arrival is an instant SQLITE_BUSY.
 */
describe('a write that meets another process holding the write lock', () => {
  it('waits for it and lands once the other process lets go', async () => {
    const holder = await holdWriteLock(dataDir)
    const db = await getDb(dataDir)
    const write = acquireLease(db, lease)
    // Contended for real: the write has not settled while the lock is held.
    expect(await stillPendingAfter(write, 100)).toBe(true)
    await holder.release()
    await expect(write).resolves.toBe(true)
  })

  it('waits for the lock a transaction takes at its start', async () => {
    const holder = await holdWriteLock(dataDir)
    const db = await getDb(dataDir)
    const transaction = db
      .transaction()
      .execute((trx) =>
        trx.insertInto('leases').values({ name: 'tx', holder: 'me', expiresAt: 1 }).execute(),
      )
    expect(await stillPendingAfter(transaction, 100)).toBe(true)
    await holder.release()
    await expect(transaction).resolves.toBeDefined()
  })

  /**
   * A statement refused as busy is left unfinished on libsql's shared
   * connection, and the next transaction to take that connection cannot
   * commit ("SQL statements in progress"). Retrying a write is only safe if the
   * transaction that follows it still commits.
   */
  it('still commits the next transaction after a refused write was retried', async () => {
    const holder = await holdWriteLock(dataDir)
    const db = await getDb(dataDir)
    const write = acquireLease(db, lease)
    expect(await stillPendingAfter(write, 100)).toBe(true)
    await holder.release()
    await write
    await expect(
      db
        .transaction()
        .execute((trx) =>
          trx.insertInto('leases').values({ name: 'after', holder: 'me', expiresAt: 1 }).execute(),
        ),
    ).resolves.toBeDefined()
  })

  it('names the contention once the wait outlasts its budget', async () => {
    const holder = await holdWriteLock(dataDir)
    const impatient = new Kysely<DatabaseSchema>({
      dialect: busyRetryingDialect(
        { url: `file:${join(dataDir, DB_FILENAME)}` },
        { ceilingMs: 150, baseDelayMs: 5, maxDelayMs: 20 },
      ),
    })
    try {
      const error = await impatient
        .insertInto('leases')
        .values({ name: 'late', holder: 'me', expiresAt: 1 })
        .execute()
        .catch((err: unknown) => err)
      expect(error).toMatchObject({ name: 'DatabaseBusyError', code: 'SQLITE_BUSY' })
      expect((error as { attempts: number }).attempts).toBeGreaterThan(1)
      // The ceiling bounds what is SCHEDULED; a timer fires late on a loaded
      // machine, so the wait is read against it with a margin.
      expect((error as { waitedMs: number }).waitedMs).toBeLessThan(150 + 500)
    } finally {
      await impatient.destroy()
      await holder.release()
    }
  })

  /**
   * The stall ceiling is what the daemon owes every OTHER request while one
   * write waits. Measured over a 300ms wait at a machine load average near 50
   * on 4 cores: worst single stall 10-35ms. 150ms is four times that and less
   * than half of the 400ms a synchronous wait produces here (the calibration
   * below), so it separates the two with room on both sides.
   */
  it('keeps the event loop serving while it waits', async () => {
    const holder = await holdWriteLock(dataDir)
    const db = await getDb(dataDir)
    const { result, availability } = await measureLoopAvailability(async () => {
      const write = acquireLease(db, lease)
      expect(await stillPendingAfter(write, 300)).toBe(true)
      await holder.release()
      return write
    })
    expect(result).toBe(true)
    expect(availability.worstStallMs).toBeLessThan(150)
  })

  /**
   * Why the wait is the store's and not SQLite's: with a busy_timeout on the
   * same file the same arrangement freezes the loop for the timeout's whole
   * length. This is the instrument's calibration — a ceiling above is only
   * worth something if the sampler can see the stall it guards against.
   */
  it('sees a synchronous busy_timeout stall the loop (calibration)', async () => {
    const holder = await holdWriteLock(dataDir)
    const client = createClient({ url: `file:${join(dataDir, DB_FILENAME)}` })
    try {
      await client.execute('PRAGMA busy_timeout = 400')
      const { availability } = await measureLoopAvailability(async () => {
        await client
          .execute({
            sql: "insert into leases (name, holder, expiresAt) values ('sync', 'me', 1)",
            args: [],
          })
          .catch(() => undefined)
      })
      expect(availability.worstStallMs).toBeGreaterThan(300)
    } finally {
      client.close()
      await holder.release()
    }
  })
})
