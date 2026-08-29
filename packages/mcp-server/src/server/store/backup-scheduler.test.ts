import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { createBackupLease, createBackupScheduler } from './backup-scheduler.js'
import { createIsolatedDb } from './db/test-helpers.js'

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

  /**
   * "3am in whose zone" is the question a schedule silently gets wrong, so
   * the answer is said out loud once, at startup: the zone that was
   * resolved, and the absolute instant the next pass falls on. The instant
   * is what makes it checkable — a zone name alone still needs the reader to
   * do the arithmetic.
   */
  it('says which zone it resolved and when the next backup falls', async () => {
    const capture = captureLogsForTests()
    try {
      const scheduler = createBackupScheduler({
        dataDir: join(root, 'data'),
        backupDir: join(root, 'backups'),
        schedule: { expression: '0 3 * * *', timezone: 'Asia/Tokyo' },
        now: () => new Date('2026-03-04T05:06:07.000Z'),
        runBackup: async () => ({ kind: 'ok' as const }),
      })
      scheduler.start()
      await scheduler.stop()

      const armed = capture.records.find(
        (r) => r.scope === 'backup-scheduler' && r.level === 'info',
      )
      expect(armed?.data).toMatchObject({
        timezone: 'Asia/Tokyo',
        schedule: '0 3 * * *',
        // It is already 14:06 JST when this starts, so the next 03:00 JST
        // is the 5th — 18:00 UTC on the 4th. An operator reading this can
        // tell at a glance whether it is their quiet hour, which a zone name
        // on its own does not let them do.
        nextRun: '2026-03-04T18:00:00.000Z',
      })
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

/**
 * ADR-0020: several instances doing the same discardable work is exactly what
 * a leader lease is for, and a backup is the clearest case of it. Two
 * instances sharing a data directory do not merely take two backups — their
 * retention passes each delete from a set the other is changing, so the
 * survivors are whichever pair of passes interleaved most favourably.
 *
 * Cron makes it worse rather than better: an interval starts from each
 * instance's own restart and drifts apart, while `0 3 * * *` fires on every
 * instance in the same minute.
 */
describe('createBackupScheduler leader lease', () => {
  it('stands down when another instance holds the lease', async () => {
    const capture = captureLogsForTests()
    try {
      const backupDir = join(root, 'backups')
      const runBackup = vi.fn(async () => ({ kind: 'ok' as const }))
      const scheduler = createBackupScheduler({
        dataDir: join(root, 'data'),
        backupDir,
        runBackup,
        runExclusively: async () => ({ ok: false, reason: 'not-leader' }),
      })
      await scheduler.runOnceForTests()

      expect(runBackup).not.toHaveBeenCalled()
      // Standing down is not a failure, so it must not be reported as one —
      // an operator watching for a broken backup would see every follower
      // instance shouting nightly.
      expect(capture.records.filter((r) => r.level === 'error')).toEqual([])
    } finally {
      capture.restore()
    }
  })

  /**
   * Retention has to be inside the lease, not merely the backup. A follower
   * that skipped the pass but still pruned would be deleting on the strength
   * of a count it did not take.
   */
  it('does not apply retention when it stood down', async () => {
    const backupDir = join(root, 'backups')
    // TWO, against a `keep` of one. With a single existing backup retention
    // deletes nothing whether it runs or not, so the test would pass on code
    // that pruned regardless — it has to be able to delete something before
    // its not deleting anything means a thing.
    await mkdir(join(backupDir, '2026-01-01T00-00-00.000Z'), { recursive: true })
    await mkdir(join(backupDir, '2026-01-02T00-00-00.000Z'), { recursive: true })
    const scheduler = createBackupScheduler({
      dataDir: join(root, 'data'),
      backupDir,
      keep: 1,
      runBackup: async () => ({ kind: 'ok' as const }),
      runExclusively: async () => ({ ok: false, reason: 'not-leader' }),
    })
    await scheduler.runOnceForTests()

    expect((await readdir(backupDir)).sort()).toEqual([
      '2026-01-01T00-00-00.000Z',
      '2026-01-02T00-00-00.000Z',
    ])
  })

  /**
   * Fail CLOSED. If leadership cannot be established the pass does not run —
   * the cost is one missed nightly backup on a deployment whose database is
   * unreachable, which is a deployment whose backup would have failed at the
   * snapshot step anyway. Running regardless would put every instance back to
   * backing up at once precisely when the shared store is unwell.
   */
  it('skips the pass when the lease cannot be reached', async () => {
    const capture = captureLogsForTests()
    try {
      const runBackup = vi.fn(async () => ({ kind: 'ok' as const }))
      const scheduler = createBackupScheduler({
        dataDir: join(root, 'data'),
        backupDir: join(root, 'backups'),
        runBackup,
        runExclusively: async () => {
          throw new Error('database unreachable')
        },
      })
      await scheduler.runOnceForTests()

      expect(runBackup).not.toHaveBeenCalled()
      expect(capture.records.some((r) => r.level === 'error')).toBe(true)
    } finally {
      capture.restore()
    }
  })

  /**
   * The end of it, against the real lease and one shared database: two
   * schedulers, the same minute, one backup. This is the arrangement the
   * whole mechanism exists for, and the one a fake `runExclusively` cannot
   * prove anything about.
   */
  it('takes one backup between two instances sharing a database', async () => {
    const handle = await createIsolatedDb({ dataDir: join(root, 'data') })
    try {
      const backupDir = join(root, 'backups')
      // Counted, not inferred from the directory listing: both instances fire
      // in the same minute, so they would write the same timestamped NAME —
      // a listing of one entry is what a total absence of coordination looks
      // like too.
      const taken: string[] = []
      const instance = (holder: string) =>
        createBackupScheduler({
          dataDir: join(root, 'data'),
          backupDir,
          now: () => new Date('2026-03-04T03:00:00.000Z'),
          runExclusively: createBackupLease({ holder, getDb: async () => handle.db }),
          runBackup: async (_dataDir, outputDir) => {
            taken.push(holder)
            await mkdir(outputDir, { recursive: true })
            await new Promise((r) => setTimeout(r, 20))
            return { kind: 'ok' as const }
          },
        })

      await Promise.all([
        instance('instance-a').runOnceForTests(),
        instance('instance-b').runOnceForTests(),
      ])

      expect(taken).toHaveLength(1)
      expect(await readdir(backupDir)).toEqual(['2026-03-04T03-00-00.000Z'])
    } finally {
      await handle.dispose()
    }
  })

  /**
   * And the lease is given back, so the follower is not locked out of the
   * NEXT night by a TTL covering work that finished hours ago.
   */
  it('lets the other instance take the following pass', async () => {
    const handle = await createIsolatedDb({ dataDir: join(root, 'data') })
    try {
      const backupDir = join(root, 'backups')
      const taken: string[] = []
      const instance = (holder: string, at: string) =>
        createBackupScheduler({
          dataDir: join(root, 'data'),
          backupDir,
          now: () => new Date(at),
          runExclusively: createBackupLease({ holder, getDb: async () => handle.db }),
          runBackup: async (_dataDir, outputDir) => {
            taken.push(holder)
            await mkdir(outputDir, { recursive: true })
            return { kind: 'ok' as const }
          },
        })

      await instance('instance-a', '2026-03-04T03:00:00.000Z').runOnceForTests()
      await instance('instance-b', '2026-03-05T03:00:00.000Z').runOnceForTests()

      expect(taken).toEqual(['instance-a', 'instance-b'])
    } finally {
      await handle.dispose()
    }
  })
})
