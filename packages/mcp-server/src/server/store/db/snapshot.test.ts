import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotDatabaseInto } from './snapshot.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-snapshot-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function seedWalDatabase(rows: number): Promise<string> {
  const path = join(dir, 'whiteboard.db')
  const c = createClient({ url: `file:${path}` })
  await c.execute('pragma journal_mode=wal')
  await c.execute('create table t (i integer primary key, v text)')
  for (let i = 0; i < rows; i++) {
    await c.execute({ sql: 'insert into t (v) values (?)', args: [`row-${i}`] })
  }
  // Deliberately NOT closed: the newest commits stay in the -wal, which is
  // the state a running daemon's directory is always in.
  return path
}

/**
 * The rows are captured THROUGH the database, not by copying its files
 * (ADR-0021 decision 3).
 *
 * A file copy has to take `whiteboard.db`, `-wal` and `-shm` as one artifact
 * and get all three, because the newest commits live in the `-wal` until a
 * checkpoint folds them back. Taking only the main file loses them silently —
 * measured at 4977 of 5000 rows. `VACUUM INTO` sidesteps the whole question
 * by writing one self-contained database.
 */
describe('snapshotDatabaseInto', () => {
  it('captures rows that are still only in the write-ahead log', async () => {
    await seedWalDatabase(3000)
    const dest = join(dir, 'snap.db')

    await snapshotDatabaseInto(dir, dest)

    const reader = createClient({ url: `file:${dest}` })
    try {
      const integrity = await reader.execute('pragma integrity_check')
      expect(integrity.rows[0]?.[0]).toBe('ok')
      const count = await reader.execute('select count(*) as n from t')
      expect(Number(count.rows[0]?.n)).toBe(3000)
    } finally {
      reader.close()
    }
    // 60s, not the project's 10s. Seeding 3000 rows is 3000 sequential
    // awaited round-trips — I/O- and IPC-bound work, which degrades hard
    // under CPU contention rather than in proportion to it. Measured: 966ms
    // on an idle tree, 1266ms with the whole mcp-node project running in
    // parallel, and a 10s timeout on a CI shard. The budget is here to catch
    // a hang, and at ~1.3s of real work it still does; sized on those
    // numbers rather than on the failure, and only this case needs it (the
    // other two seed 50 and 10 rows).
  }, 60_000)

  /**
   * One file, not three. A backup holding a bare `whiteboard.db` needs no
   * sidecars to be complete, so nothing downstream has to know they exist.
   */
  it('writes a single self-contained file', async () => {
    await seedWalDatabase(50)
    const destDir = join(dir, 'out')
    const dest = join(destDir, 'whiteboard.db')

    await snapshotDatabaseInto(dir, dest)

    expect(await readdir(destDir)).toEqual(['whiteboard.db'])
  })

  /**
   * `VACUUM INTO` refuses a target that already exists, and the message
   * SQLite gives for it is not one an operator can act on. Fail with
   * something that names the real situation instead.
   */
  it('refuses a destination that is already occupied', async () => {
    await seedWalDatabase(10)
    const dest = join(dir, 'taken.db')
    await snapshotDatabaseInto(dir, dest)

    await expect(snapshotDatabaseInto(dir, dest)).rejects.toThrow(/already exists/i)
  })
})
