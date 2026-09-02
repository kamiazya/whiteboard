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
 * Ten sampler intervals. Long enough that "no tick landed" is a statement
 * about the call rather than about timer granularity, and short enough that
 * the growth loop reaches it in a round or two on any machine.
 */
const MIN_SNAPSHOT_MS = 50

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
  // The growth loop's cost is a property of the machine, so the BUDGET has
  // to cover the slowest runner too: under a loaded CI runner the sibling
  // snapshot.test.ts measured 24.6s for one capture, and this test's insert
  // rounds plus up to five snapshots blew the project's 10s default. 60s is
  // sized from that measurement, not the seed/timeout confusion the
  // integrator flow warns about — the property itself never failed.
  it('blocks the event loop for its whole duration', { timeout: 60_000 }, async () => {
    // The fixture GROWS until the snapshot is long enough for the answer to
    // mean anything, rather than being a size someone measured once.
    //
    // "How many milliseconds is 16MB" is a property of the machine, not of
    // the fixture. This floor was a constant and it failed on CI at the first
    // attempt: 16MB snapshotted in 51.3ms there against a 60ms floor written
    // from a slower local run — a green local suite and a red CI job over the
    // same code. Raising the constant only moves the cliff to the next faster
    // runner; measuring until the subject is reached has no cliff.
    await sql`create table bulk (id integer primary key, payload blob)`.execute(handle.db)
    const payload = Buffer.alloc(64 * 1024, 7)
    let availability: Awaited<ReturnType<typeof measureLoopAvailability<void>>>['availability'] =
      undefined as never
    for (let attempt = 0; attempt < 5; attempt++) {
      // Doubling, so a fast machine reaches the floor in a couple of rounds
      // instead of creeping. `VACUUM INTO` refuses an existing target, so
      // each attempt writes its own.
      for (let i = 0; i < 64 * 2 ** attempt; i++) {
        await sql`insert into bulk (payload) values (${payload})`.execute(handle.db)
      }
      availability = (
        await measureLoopAvailability(
          () => snapshotDatabaseInto(join(root, 'data'), join(root, `snapshot-${attempt}.db`)),
          { intervalMs: 5 },
        )
      ).availability
      if (availability.elapsedMs > MIN_SNAPSHOT_MS) break
    }

    // Reached, not assumed: a snapshot finishing inside a couple of sampler
    // intervals would report "fully blocked" whether it blocked or not, so
    // this asserts the growth loop actually got the subject in range.
    expect(availability.elapsedMs).toBeGreaterThan(MIN_SNAPSHOT_MS)
    // Fully blocked, allowing a little slack for a tick landing at either
    // edge. Were this call to become non-blocking, `blockedMs` would collapse
    // toward zero and this is where that shows up.
    expect(availability.blockedMs).toBeGreaterThan(availability.elapsedMs * 0.8)
  })
})
