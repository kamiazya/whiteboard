import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureLoopAvailability } from '../../../shared/test-utils/loop-availability.js'
import { snapshotDatabaseInto } from './snapshot.js'
import { createIsolatedDb } from './test-helpers.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-snap-block-'))
  // File-backed: `VACUUM INTO` goes through the real driver against a real
  // database file, which is the arrangement whose cost is in question.
  handle = await createIsolatedDb({ dataDir: join(root, 'data'), memory: false })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * The measurement the backup's architecture rests on, pinned.
 *
 * `backup-scheduler` runs its pass in a CHILD PROCESS, and the whole reason is
 * that this call blocks the Node event loop for its entire duration — 1242ms
 * at a 103MB database, 4767ms at 421MB, growing with the data. Inside the
 * daemon that is every request stopped for seconds, nightly.
 *
 * Nothing in the source says so: an `await` on a native binding reads exactly
 * like an `await` on a socket. So if a later `@libsql/client` moves this work
 * off the main thread, the decision that put a whole subprocess in the way
 * would quietly become unnecessary and nobody would find out. This test is
 * how that gets noticed — it fails, and the failure points at
 * `background-work.ts`'s declaration for the backup scheduler.
 *
 * It asserts the DIRECTION, not a duration: "this call blocks throughout" is
 * stable across machines in a way "this takes 1242ms" is not.
 */
describe('the hot snapshot', () => {
  it('blocks the event loop for its whole duration', async () => {
    // ~16MB. Sized from a measurement, not a guess: 4MB snapshots in about
    // 29ms, which is six sampler intervals and close enough to the floor
    // below to fail on a fast run. This is comfortably clear of it.
    await sql`create table bulk (id integer primary key, payload blob)`.execute(handle.db)
    const payload = Buffer.alloc(64 * 1024, 7)
    for (let i = 0; i < 256; i++) {
      await sql`insert into bulk (payload) values (${payload})`.execute(handle.db)
    }

    const { availability } = await measureLoopAvailability(
      () => snapshotDatabaseInto(join(root, 'data'), join(root, 'snapshot.db')),
      { intervalMs: 5 },
    )

    // The fixture has to be big enough for the answer to mean anything: a
    // snapshot finishing inside a couple of sampler intervals would report
    // "fully blocked" whether it blocked or not.
    expect(availability.elapsedMs).toBeGreaterThan(60)
    // Fully blocked, allowing a little slack for a tick landing at either
    // edge. Were this call to become non-blocking, `blockedMs` would collapse
    // toward zero and this is where that shows up.
    expect(availability.blockedMs).toBeGreaterThan(availability.elapsedMs * 0.8)
  })
})
