import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PENDING_WRITES_DIRNAME } from '../atomic-write.js'
import { backupIsInProgress, withBackupMarker } from './backup-in-progress.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-backup-marker-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * File-GC must not delete while a backup is being assembled.
 *
 * A backup captures the rows as a snapshot and the uploads as a directory
 * copy, and those are two moments. Between them, a GC pass that unlinks a
 * file the snapshot still references leaves a backup that restores to a
 * document pointing at nothing — silently, since every step reported success.
 *
 * That is ADR-0021 decision 6's far end ("retention must not delete behind")
 * in the shape this system has today. The channel has to be the filesystem:
 * `whiteboard server backup` runs host-side as a SEPARATE process from the
 * daemon that runs GC, so no in-memory lock can reach across.
 *
 * Standing down costs nothing. GC is periodic — 24h by default — so a pass
 * skipped for the duration of a backup simply happens on the next tick.
 */
describe('the backup-in-progress marker', () => {
  it('is absent when no backup is running', async () => {
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  it('is visible to another process for the duration of the backup', async () => {
    let seenDuring = false
    await withBackupMarker(dir, async () => {
      seenDuring = await backupIsInProgress(dir)
    })
    expect(seenDuring).toBe(true)
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  it('is cleared even when the backup throws', async () => {
    await expect(
      withBackupMarker(dir, async () => {
        throw new Error('backup blew up')
      }),
    ).rejects.toThrow('backup blew up')
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  /**
   * A marker left by a killed backup must not stop GC forever, and the thing
   * that makes that decidable is an EXPIRY the live backup keeps pushing out.
   *
   * It used to be a pid, checked with `process.kill(pid, 0)`. That answer is
   * meaningless the moment the two processes are in different containers,
   * which is exactly the arrangement this marker exists to serve: the reader
   * is the daemon's GC and the writer may be `whiteboard server backup` or
   * another instance sharing the volume. In a separate pid namespace the
   * number either matches nothing (GC deletes underneath a live backup) or
   * matches some unrelated local process (GC waits on a backup that ended
   * hours ago). Both readings are wrong and neither is detectable.
   */
  it('is ignored once it has gone unrefreshed', async () => {
    await writeFile(
      join(dir, 'backup-in-progress.json'),
      JSON.stringify({
        schemaVersion: 2,
        holder: 'some-other-instance',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: Date.now() - 1,
      }),
    )
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  /**
   * And the converse, which is the defect the pid check actually caused: a
   * backup running in another container is honoured, because nothing about
   * the reader's own process table enters into it.
   */
  it('is honoured while another container is still refreshing it', async () => {
    await writeFile(
      join(dir, 'backup-in-progress.json'),
      JSON.stringify({
        schemaVersion: 2,
        holder: 'some-other-instance',
        startedAt: new Date().toISOString(),
        expiresAt: Date.now() + 60_000,
      }),
    )
    expect(await backupIsInProgress(dir)).toBe(true)
  })

  /**
   * A backup takes as long as the data makes it take, so the marker is kept
   * fresh for as long as the pass runs. Without that a long copy expires its
   * own marker and GC resumes underneath it — the very window this closes.
   */
  it('stays valid across a pass longer than its own lifetime', async () => {
    // Asserted against the marker's own timestamps, never the wall clock.
    // Two earlier shapes of this test raced real timers and lost under a
    // loaded parallel suite: a 5ms refresh slipped its 40ms TTL, then a 30ms
    // refresh slipped its 300ms TTL on CI — each time measuring the
    // machine's load, not whether the marker refreshes. So the body now
    // WAITS (polling, bounded only by the test timeout) until a refresh has
    // observably pushed the deadline out, and the assertion asks
    // backupIsInProgress the deterministic question via its injectable
    // clock: at the moment the ORIGINAL deadline passed, was the refreshed
    // marker still honoured?
    const markerFile = join(dir, 'backup-in-progress.json')
    const readExpiresAt = async (): Promise<number | null> => {
      try {
        return JSON.parse(await readFile(markerFile, 'utf8')).expiresAt as number
      } catch {
        // Mid-write or not yet written: not an answer, poll again.
        return null
      }
    }
    let seenPastOriginalDeadline = false
    await withBackupMarker(
      dir,
      async () => {
        let initial: number | null = null
        while (initial === null) initial = await readExpiresAt()
        let refreshed: number | null = null
        while (refreshed === null || refreshed <= initial) {
          await new Promise((r) => setTimeout(r, 10))
          refreshed = await readExpiresAt()
        }
        seenPastOriginalDeadline = await backupIsInProgress(dir, initial)
      },
      { ttlMs: 300, refreshEveryMs: 30 },
    )
    expect(seenPastOriginalDeadline).toBe(true)
  })

  /**
   * A refresh must never make the marker read as "no backup running".
   *
   * `backupIsInProgress` fails OPEN by design — an unreadable marker is not
   * one — so a reader that catches the marker mid-rewrite gets the same
   * answer as no backup at all, and GC resumes underneath a running one.
   * That is precisely the window `withBackupMarker` exists to close, and a
   * non-atomic rewrite reopened it once per refresh.
   *
   * The TTL here is a minute, so a `false` cannot mean expiry; it can only
   * mean the read failed. Measured against the plain `writeFile` this
   * replaced: 535 of 6860 reads answered false at a 1ms refresh, and 26 of
   * 9504 at the 30ms one the case above uses — which is what made that case
   * fail on CI, twice, through two rewrites that only moved its timing
   * around.
   *
   * Bounded by a READ COUNT, never by a duration. A time-boxed loop makes the
   * slower machine do fewer reads, which is the third time this file has been
   * bitten by a test measuring the runner's load: the first version of THIS
   * case asked for 100 reads in 300ms and got 28 on CI. A fixed count errs the
   * safe way, because a slower reader has MORE rewrites landing between its
   * reads, not fewer.
   */
  it('is never read as absent while a refresh is rewriting it', async () => {
    const READS = 300
    let absent = 0
    let rewrites = 0
    await withBackupMarker(
      dir,
      async () => {
        // Retries a torn read, for the reason the case above does: this
        // helper is scaffolding, and letting it throw would make the failure
        // read as a JSON problem instead of naming the atomicity it is here
        // to measure.
        const deadlineOf = async (): Promise<number> => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              return JSON.parse(await readFile(join(dir, 'backup-in-progress.json'), 'utf8'))
                .expiresAt as number
            } catch {
              // A torn read. Retried immediately rather than after a pause:
              // `readFile` already yields, the rewrite it collided with is
              // sub-millisecond, and a fixed sleep here is the shape
              // `test-fixed-sleep-ledger` refuses.
            }
          }
          throw new Error('the marker never read back as JSON in 100 attempts')
        }
        const before = await deadlineOf()
        for (let i = 0; i < READS; i += 1) {
          if (!(await backupIsInProgress(dir, Date.now()))) absent += 1
        }
        // Proves rewrites really overlapped the reads, rather than asserting
        // a read count that only says how fast the machine is. Read after the
        // loop, so it cannot be satisfied by a refresh that landed before it.
        rewrites = (await deadlineOf()) > before ? 1 : 0
      },
      { ttlMs: 60_000, refreshEveryMs: 1 },
    )
    expect(rewrites).toBe(1)
    expect(absent).toBe(0)
  })

  /** Fail OPEN: an unreadable marker must not wedge GC permanently. */
  it('is ignored when it cannot be read as a marker', async () => {
    await writeFile(join(dir, 'backup-in-progress.json'), 'not json')
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  /**
   * The MARKER leaves nothing behind. The staging directory the atomic write
   * uses is not this module's to remove — it is one shared directory at the
   * top of the data dir, used concurrently by every writer here, so deleting
   * it in this `finally` would pull the ground from under a blob put that is
   * mid-flight. It is empty, excluded from backups, and stays.
   *
   * Asserted as an exact set rather than "no marker", so a future writer that
   * really does leak a file still fails here.
   */
  it('leaves nothing behind but the shared staging directory', async () => {
    await withBackupMarker(dir, async () => {})
    expect(await readdir(dir)).toEqual([PENDING_WRITES_DIRNAME])
    expect(await readdir(join(dir, PENDING_WRITES_DIRNAME))).toEqual([])
  })
})
