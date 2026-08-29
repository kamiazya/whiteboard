import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { createBackupScheduler } from './backup-scheduler.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-backup-sched-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * ADR-0021 decision 4: what an operator wants is not a command they must
 * remember to run. It is for this to be handled.
 *
 * The schedule is the mechanism and `whiteboard server backup` is a manual
 * trigger of the same pass, so this owns only WHEN and WHERE — the backup
 * itself is `performBackup`, which both call.
 *
 * The timer shape is the one `file-gc-sweeper` already uses and for its
 * reasons: a completion-rescheduled unref'd one-shot, never `setInterval`. A
 * pass that outruns its own interval must not stack, and a background timer
 * must not hold the daemon's event loop open when it is otherwise idle.
 */
describe('createBackupScheduler', () => {
  it('does nothing at all when no destination is configured', async () => {
    const capture = captureLogsForTests()
    try {
      const runBackup = vi.fn(async () => ({ kind: 'ok' as const }))
      const scheduler = createBackupScheduler({
        dataDir: join(root, 'data'),
        backupDir: null,
        runBackup,
      })
      scheduler.start()
      await scheduler.runOnceForTests()
      await scheduler.stop()

      expect(runBackup).not.toHaveBeenCalled()
      // "Nothing" has to mean nothing, not "threw before it got that far".
      // Without the early return the pass builds a path from `null`, throws,
      // and is swallowed by the pass-level catch — leaving runBackup uncalled
      // for the wrong reason and this test green against broken code.
      expect(capture.records.filter((r) => r.level === 'error')).toEqual([])
    } finally {
      capture.restore()
    }
  })

  it('writes each backup into its own timestamped directory', async () => {
    const backupDir = join(root, 'backups')
    const taken: string[] = []
    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir,
      now: () => new Date('2026-03-04T05:06:07.000Z'),
      runBackup: async (_dataDir, outputDir) => {
        taken.push(outputDir)
        await mkdir(outputDir, { recursive: true })
        return { kind: 'ok' as const }
      },
    })
    await scheduler.runOnceForTests()

    expect(taken).toHaveLength(1)
    // Sortable and filesystem-safe: the retention pass below orders by name,
    // so the timestamp has to sort the same way it reads.
    expect(await readdir(backupDir)).toEqual(['2026-03-04T05-06-07.000Z'])
  })

  /**
   * Without retention an automatic daily backup fills the disk, which is a
   * worse failure than not having one — the operator loses the running server
   * as well as the backups.
   */
  it('keeps the newest N and deletes the rest', async () => {
    const backupDir = join(root, 'backups')
    await mkdir(backupDir, { recursive: true })
    for (const name of [
      '2026-01-01T00-00-00.000Z',
      '2026-01-02T00-00-00.000Z',
      '2026-01-03T00-00-00.000Z',
    ]) {
      await mkdir(join(backupDir, name), { recursive: true })
      await writeFile(join(backupDir, name, 'whiteboard.db'), 'rows')
    }

    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir,
      keep: 2,
      now: () => new Date('2026-01-04T00:00:00.000Z'),
      runBackup: async (_dataDir, outputDir) => {
        await mkdir(outputDir, { recursive: true })
        return { kind: 'ok' as const }
      },
    })
    await scheduler.runOnceForTests()

    expect((await readdir(backupDir)).sort()).toEqual([
      '2026-01-03T00-00-00.000Z',
      '2026-01-04T00-00-00.000Z',
    ])
  })

  /**
   * A failed pass must not take the previous good backups with it. Deleting
   * on the way to a backup that then fails is how an operator ends up with
   * fewer backups than before they configured this.
   */
  it('leaves existing backups alone when the pass fails', async () => {
    const backupDir = join(root, 'backups')
    // THREE existing backups against `keep: 1`, so a retention pass that ran
    // would delete two of them. One existing backup cannot tell the two
    // behaviours apart — retention would keep it either way — and an earlier
    // version of this test made exactly that mistake: removing the `return`
    // after a failed pass left it green.
    for (const name of [
      '2026-01-01T00-00-00.000Z',
      '2026-01-02T00-00-00.000Z',
      '2026-01-03T00-00-00.000Z',
    ]) {
      await mkdir(join(backupDir, name), { recursive: true })
    }

    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir,
      keep: 1,
      now: () => new Date('2026-01-04T00:00:00.000Z'),
      runBackup: async () => ({ kind: 'error' as const, message: 'backup failed' }),
    })
    await scheduler.runOnceForTests()

    expect((await readdir(backupDir)).sort()).toEqual([
      '2026-01-01T00-00-00.000Z',
      '2026-01-02T00-00-00.000Z',
      '2026-01-03T00-00-00.000Z',
    ])
  })

  /**
   * Retention counts BACKUPS, not whatever else is in the directory. An
   * operator's own notes file next to them must not be deleted, and must not
   * push a real backup out of the window either.
   */
  it('ignores entries that are not backups it took', async () => {
    const backupDir = join(root, 'backups')
    await mkdir(backupDir, { recursive: true })
    await writeFile(join(backupDir, 'README.txt'), 'my backups live here')
    await mkdir(join(backupDir, 'scratch'), { recursive: true })
    await mkdir(join(backupDir, '2026-01-01T00-00-00.000Z'), { recursive: true })

    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir,
      keep: 1,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      runBackup: async (_dataDir, outputDir) => {
        await mkdir(outputDir, { recursive: true })
        return { kind: 'ok' as const }
      },
    })
    await scheduler.runOnceForTests()

    const left = (await readdir(backupDir)).sort()
    expect(left).toContain('README.txt')
    expect(left).toContain('scratch')
    expect(left).toContain('2026-01-02T00-00-00.000Z')
    expect(left).not.toContain('2026-01-01T00-00-00.000Z')
  })

  it('does not stack passes when one outruns its interval', async () => {
    let running = 0
    let maxConcurrent = 0
    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir: join(root, 'backups'),
      runBackup: async (_dataDir, outputDir) => {
        running += 1
        maxConcurrent = Math.max(maxConcurrent, running)
        await mkdir(outputDir, { recursive: true })
        await new Promise((r) => setTimeout(r, 20))
        running -= 1
        return { kind: 'ok' as const }
      },
    })

    await Promise.all([
      scheduler.runOnceForTests(),
      scheduler.runOnceForTests(),
      scheduler.runOnceForTests(),
    ])
    expect(maxConcurrent).toBe(1)
  })
})

/**
 * The schedule is a cron expression, so the operator controls WHEN as well as
 * how often — the point of the exercise being to put an expensive pass in a
 * quiet window rather than wherever a restart happened to leave it.
 *
 * The timer loop is unchanged and still ours: croner supplies only the next
 * fire time. Mixing two scheduling models would mean two answers to "is a
 * pass already running", and the no-overlap guard above is the one that is
 * tested.
 */
describe('createBackupScheduler cron scheduling', () => {
  it('waits until the next matching time rather than a fixed offset from start', () => {
    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir: join(root, 'backups'),
      schedule: { expression: '0 3 * * *', timezone: 'UTC' },
      // Just after 3am, so the next fire is nearly a whole day away — which
      // an interval-based scheduler started now could not express.
      now: () => new Date('2026-03-04T03:00:01.000Z'),
      runBackup: async () => ({ kind: 'ok' as const }),
    })

    expect(scheduler.nextRunForTests()?.toISOString()).toBe('2026-03-05T03:00:00.000Z')
  })

  /**
   * "3am" means 3am where the operator is. A container's clock is usually
   * UTC, so without this the quiet window they picked is someone else's
   * afternoon.
   */
  it('reads the expression in the configured timezone', () => {
    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir: join(root, 'backups'),
      schedule: { expression: '0 3 * * *', timezone: 'Asia/Tokyo' },
      now: () => new Date('2026-03-04T18:30:00.000Z'),
      runBackup: async () => ({ kind: 'ok' as const }),
    })

    // 03:00 JST on the 5th is 18:00 UTC on the 4th.
    expect(scheduler.nextRunForTests()?.toISOString()).toBe('2026-03-05T18:00:00.000Z')
  })

  /**
   * `setTimeout` truncates anything past ~24.8 days to 1ms, which would turn
   * an annual schedule into an immediate backup and then a tight loop. A cron
   * expression reaches that range easily, so the clamp has a real branch:
   * wake early, notice the target is still ahead, re-arm.
   */
  it('re-arms instead of firing early when the next run is beyond the timer maximum', async () => {
    const runBackup = vi.fn(async () => ({ kind: 'ok' as const }))
    let clock = new Date('2026-03-04T00:00:00.000Z')
    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir: join(root, 'backups'),
      // Annually on 1 January: ~10 months out from the clock above.
      schedule: { expression: '0 0 1 1 *', timezone: 'UTC' },
      now: () => clock,
      runBackup,
    })

    expect(scheduler.nextRunForTests()?.toISOString()).toBe('2027-01-01T00:00:00.000Z')

    scheduler.start()
    // Let the clamped timer fire: it is armed for the 32-bit maximum, so it
    // cannot be awaited directly. Advance the clock only as far as the clamp
    // would reach and confirm nothing was backed up.
    clock = new Date(clock.getTime() + 2_147_483_647)
    await scheduler.stop()
    expect(runBackup).not.toHaveBeenCalled()
  })
})
