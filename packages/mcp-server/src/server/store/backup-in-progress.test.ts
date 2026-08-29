import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    let seenLate = false
    await withBackupMarker(
      dir,
      async () => {
        await new Promise((r) => setTimeout(r, 120))
        seenLate = await backupIsInProgress(dir)
      },
      { ttlMs: 40, refreshEveryMs: 5 },
    )
    expect(seenLate).toBe(true)
  })

  /** Fail OPEN: an unreadable marker must not wedge GC permanently. */
  it('is ignored when it cannot be read as a marker', async () => {
    await writeFile(join(dir, 'backup-in-progress.json'), 'not json')
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  it('leaves nothing behind', async () => {
    await withBackupMarker(dir, async () => {})
    expect(await readdir(dir)).toEqual([])
  })
})
