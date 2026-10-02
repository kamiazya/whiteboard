import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKUP_MARKER_FILENAME,
  backupIsInProgress,
  withBackupMarker,
} from './backup-in-progress.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-backup-marker-defaults-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

/**
 * Production calls `withBackupMarker(dataDir, body)` with no options, while
 * every other case here passes a TTL and a refresh of its own. The defaults are
 * what decide whether file-GC stands down for the whole of a real backup, so
 * they are exercised on their own: a refresh that outgrows the TTL lets the
 * marker lapse mid-copy and GC unlinks blobs the snapshot still references.
 */
describe('the backup-in-progress marker with its default timings', () => {
  it('stays in force across a body running several lifetimes', async () => {
    // Only the interval and the clock are faked: the marker is written to a
    // real directory, and the reader takes its "now" as an argument.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const start = Date.now()
    const markerFile = join(dir, BACKUP_MARKER_FILENAME)
    const deadline = async (): Promise<number> => {
      try {
        return JSON.parse(await readFile(markerFile, 'utf8')).expiresAt as number
      } catch {
        return 0
      }
    }
    // Bounded by an attempt count, never a duration. A refresh that never
    // lands (the failure this guards against) must fall through to the
    // assertion below instead of hanging the case.
    const untilDeadlineAfter = async (floor: number): Promise<void> => {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if ((await deadline()) > floor) return
      }
    }

    // Stepped at the refresh cadence the marker documents (a quarter of its
    // lifetime) across three lifetimes. Restated here rather than imported:
    // the constants are the production module's own, and a test that read them
    // back would agree with whatever they were changed to.
    const BEAT_MS = 15_000
    const steps = 12
    const held: { elapsedMs: number; inProgress: boolean }[] = []
    await withBackupMarker(dir, async () => {
      let previous = await deadline()
      for (let step = 1; step <= steps; step += 1) {
        await vi.advanceTimersByTimeAsync(BEAT_MS)
        await untilDeadlineAfter(previous)
        previous = await deadline()
        // Just before the next refresh is due: the point where the marker is
        // closest to lapsing.
        const nearNextBeat = Date.now() + BEAT_MS - 1
        held.push({
          elapsedMs: Date.now() - start,
          inProgress: await backupIsInProgress(dir, nearNextBeat),
        })
      }
    })

    expect(held.at(-1)?.elapsedMs).toBeGreaterThan(60_000 * 2)
    expect(held.filter((sample) => !sample.inProgress)).toEqual([])
    expect(await backupIsInProgress(dir)).toBe(false)
  })
})

/**
 * What cannot be seen is held to be a backup. A marker or directory this
 * process cannot inspect is not evidence that no backup is running, and GC
 * deleting blind is the outcome the marker exists to refuse.
 */
describe('the backup-in-progress marker when it cannot be read', () => {
  it('is honoured when something that is not a file stands where the marker belongs', async () => {
    // `readFile` on a directory fails with EISDIR, which is not "missing".
    await mkdir(join(dir, BACKUP_MARKER_FILENAME))
    expect(await backupIsInProgress(dir)).toBe(true)
  })

  it('is ignored once that unreadable stand-in has gone unrefreshed', async () => {
    const standIn = join(dir, BACKUP_MARKER_FILENAME)
    await mkdir(standIn)
    const stale = new Date(Date.now() - 10 * 60_000)
    await utimes(standIn, stale, stale)
    expect(await backupIsInProgress(dir)).toBe(false)
  })

  it('is honoured when the data directory itself cannot be looked into', async () => {
    // A file where the directory should be: both the read and the stat fail
    // with ENOTDIR, neither of them "missing".
    const notADirectory = join(dir, 'data-dir-is-a-file')
    await writeFile(notADirectory, 'x')
    expect(await backupIsInProgress(notADirectory)).toBe(true)
  })

  it('is absent when the data directory does not exist, which is plain missing', async () => {
    expect(await backupIsInProgress(join(dir, 'never-created'))).toBe(false)
  })
})
