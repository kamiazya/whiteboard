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
   * A marker left by a killed backup must not stop GC forever. The pid is
   * what makes that decidable rather than a guess: a marker whose writer is
   * gone is a marker nobody is honouring.
   */
  it('is ignored once the process that wrote it is gone', async () => {
    await writeFile(
      join(dir, 'backup-in-progress.json'),
      JSON.stringify({ schemaVersion: 1, pid: 2147483646, startedAt: new Date().toISOString() }),
    )
    expect(await backupIsInProgress(dir)).toBe(false)
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
