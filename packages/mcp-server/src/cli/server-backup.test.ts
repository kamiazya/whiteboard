import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { BackupError } from '../server/server-mode-backup-restore.js'
import { backupIsInProgress } from '../server/store/backup-in-progress.js'
import { writeDatabaseLocationRecord } from '../server/store/db/location-record.js'
import { runServerBackup } from './server-backup.js'

let tmpRoot: string

beforeEach(async () => {
  // Canonicalize via realpath so paths don't traverse system-level symlinks
  // (e.g. /var → /private/var on macOS) that would trip hasAncestorSymlink.
  tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'wb-server-backup-test-')))
})
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('runServerBackup', () => {
  it('success: calls doBackup with resolved paths and non-tautological allowedRoots', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir)
    // A data directory with no database is refused now (see the host-shell
    // case at the bottom of this file), so the happy paths seed one.
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const capturedCalls: [string, string, BackupRestoreOptions][] = []
    const mockDoBackup = vi.fn(async (src: string, dest: string, opts: BackupRestoreOptions) => {
      capturedCalls.push([src, dest, opts])
    })

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.result).toMatchObject({
        schemaVersion: 2,
        ok: true,
        operation: 'backup',
        // `ok` alone can no longer answer "is my backup good?" — it says the
        // operation did what it is responsible for, and `stores` says what
        // that covered.
        stores: { database: { captured: true }, blobs: { captured: true } },
      })
      // outputDir must NOT appear in success result (non-leak policy).
      expect(outcome.result).not.toHaveProperty('outputDir')
    }

    expect(capturedCalls).toHaveLength(1)
    const [src, dest, opts] = capturedCalls[0]
    expect(src).toBe(join(tmpRoot, 'data'))
    // The STAGING name, not the operator's. Nothing is assembled under a
    // backup's own name until every store has finished with it, so the helper
    // is handed somewhere else and the rename is what publishes the result
    // (ADR-0021 decision 6's near end).
    expect(dest).toBe(`${join(tmpRoot, 'backup')}.incomplete`)

    // allowedRoots uses dirname(outputDir), NOT outputDir itself, so the
    // helper's assertWithinAllowed check is non-tautological — and the
    // staging directory is a sibling, so it stays inside that root.
    expect(opts.allowedRoots).toContain(join(tmpRoot, 'data'))
    expect(opts.allowedRoots).toContain(tmpRoot) // dirname of outputDir
    expect(opts.allowedRoots).not.toContain(join(tmpRoot, 'backup')) // NOT self
  })

  it('missing outputDir: delegates to helper without pre-creating the directory', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'new-backup')
    await mkdir(dataDir)
    // A data directory with no database is refused now (see the host-shell
    // case at the bottom of this file), so the happy paths seed one.
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    // Checked AT the moment of delegation, not after the pass. Pre-creating
    // is what would break `backupDataDir`'s `errorOnExist` guard, and that
    // guard is consulted when the helper runs — so this is the instant the
    // question is about. Later steps legitimately write into the directory
    // the helper created: the snapshot lands there, and so does the blob
    // manifest.
    let existedWhenDelegated: boolean | null = null
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: vi.fn(async () => {
        existedWhenDelegated = await lstat(outputDir).then(
          () => true,
          () => false,
        )
      }),
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    expect(existedWhenDelegated).toBe(false)
  })

  it('ancestor-symlink: path through a symlink ancestor is rejected (fail-closed)', async () => {
    const realOutside = join(tmpRoot, 'real-outside')
    const link = join(tmpRoot, 'link-to-real')
    await mkdir(realOutside)
    await symlink(realOutside, link)

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: join(link, 'backup'), dataDir: tmpRoot },
      env: {},
      doBackup: vi.fn(),
      doSnapshot: async () => {},
    })

    // Ancestor symlink must be rejected, not followed.
    expect(outcome.kind).toBe('invalid-output-path')
  })

  it('error: doBackup throws BackupError (non-empty outputDir) → generic error, no path leak', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'non-empty')
    await mkdir(dataDir)
    // A data directory with no database is refused now (see the host-shell
    // case at the bottom of this file), so the happy paths seed one.
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')
    await mkdir(outputDir)
    await writeFile(join(outputDir, 'canary.txt'), 'content')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: vi.fn(async () => {
        throw new BackupError('Backup directory is not empty.')
      }),
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.message).not.toMatch(new RegExp(tmpRoot.replace(/[/\\]/g, '.')))
      expect(outcome.message).not.toMatch(/not empty/)
      expect(outcome.message).toBe('backup failed')
    }
  })

  /**
   * A running server used to be a refusal outright. That is gone, and this is
   * where the old pair of tests for it lived — the `running-server` outcome
   * no longer exists, so pinning it would pin nothing.
   *
   * What replaced it is exercised in full further down ("runServerBackup
   * against a running server"): the rows are snapshotted through the database
   * rather than read out from under a writer, every write into the data
   * directory lands atomically so a copy cannot pick one up half-written, and
   * file-GC stands down for the duration so nothing is unlinked between the
   * snapshot and the copy.
   */

  it('invalid-output-path: symlink output dir is rejected', async () => {
    const realDir = join(tmpRoot, 'real')
    const linkPath = join(tmpRoot, 'link')
    await mkdir(realDir)
    await symlink(realDir, linkPath)

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: linkPath, dataDir: tmpRoot },
      env: {},
      doBackup: vi.fn(),
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('invalid-output-path')
  })

  it('ancestor-symlink: symlinked dataDir is rejected (fail-closed)', async () => {
    const realData = join(tmpRoot, 'real-data')
    const link = join(tmpRoot, 'link-to-data')
    await mkdir(realData)
    await symlink(realData, link)

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: join(tmpRoot, 'out'), dataDir: link },
      env: {},
      doBackup: vi.fn(),
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('error')
  })

  it('invalid-output-path: plain file output is rejected', async () => {
    const filePath = join(tmpRoot, 'not-a-dir.txt')
    await writeFile(filePath, 'content')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: filePath, dataDir: tmpRoot },
      env: {},
      doBackup: vi.fn(),
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('invalid-output-path')
  })

  it('non-leak: outcome does not contain raw dataDir path', async () => {
    const dataDir = join(tmpRoot, 'src')
    await mkdir(dataDir)
    // A data directory with no database is refused now (see the host-shell
    // case at the bottom of this file), so the happy paths seed one.
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')
    const outputDir = join(tmpRoot, 'out')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: vi.fn(async () => {
        throw new BackupError('some internal error with path /internal/detail')
      }),
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.message).not.toMatch(/internal/)
      expect(outcome.message).not.toMatch(/Bearer/i)
      expect(outcome.message).not.toMatch(/Authorization/i)
    }
  })
})

/**
 * A backup that reports success while carrying no rows is worse than no
 * backup: the operator believes they have one. Measured before this guard
 * existed — with a remote database configured, `runServerBackup` answered
 * `{"ok":true}` over a backup directory containing `[ 'blobs' ]` alone.
 *
 * The whole-directory copy is what assumes the rows are in the directory.
 * That assumption held for every install until the database could be pointed
 * elsewhere, and nothing re-asked it when that changed.
 */
describe('runServerBackup with the database outside the data directory', () => {
  /**
   * This case used to refuse outright, and the invariant that refusal
   * protected is the one asserted here: a backup must never be presented as
   * holding rows it does not hold. What changed is how it is protected —
   * by reporting per store and leaving the fossil out, rather than by
   * declining to save the blobs too.
   */
  it('leaves a stale database out of the copy instead of refusing everything', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir)
    // The fossil: what a move to libSQL leaves behind.
    await writeFile(join(dataDir, 'whiteboard.db'), 'pre-migration rows')

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: { WHITEBOARD_DATABASE_URL: 'libsql://db.example.com' },
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.result.stores.database).toEqual({
      captured: false,
      reason: 'hosted-elsewhere',
    })
    // The copy is instructed to skip the fossil. Without this the backup
    // would carry pre-migration rows that restore puts back as current.
    expect(mockDoBackup).toHaveBeenCalledTimes(1)
    expect(mockDoBackup.mock.calls[0][2]).toMatchObject({ excludeDatabaseFile: true })
  })

  it('still backs up normally when the database is the data directory file', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir)
    // A data directory with no database is refused now (see the host-shell
    // case at the bottom of this file), so the happy paths seed one.
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: { WHITEBOARD_DATABASE_URL: `file:${join(dataDir, 'whiteboard.db')}` },
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoBackup).toHaveBeenCalledTimes(1)
  })
})

/**
 * The guard must not depend on the invoking shell's environment.
 *
 * `docs/how-to/self-host-with-docker.md` tells the operator to stop the
 * container and run this command HOST-side. `WHITEBOARD_DATABASE_URL` lives
 * in the container's --env-file, so the host shell does not have it: an
 * env-only check reads a clean environment, concludes the database is local,
 * and copies a directory that has no database in it.
 *
 * Measured before this test existed, with the env deliberately empty:
 *
 *     outcome: {"ok":true,"operation":"backup"}   backup: [ 'blobs' ]
 *
 * — the exact failure this whole change set out to remove, reached through
 * the documented workflow. So the decision is made from the ARTIFACT: if the
 * directory holds no database file, the copy cannot hold rows, whatever any
 * environment says.
 */
describe('runServerBackup judges from the directory, not the invoking shell', () => {
  it('refuses when the data directory holds no database, even with a clean env', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(join(dataDir, 'blobs'), { recursive: true })

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('missing-database')
    expect(mockDoBackup).not.toHaveBeenCalled()
  })

  it('proceeds when the database file is actually there', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoBackup).toHaveBeenCalledTimes(1)
  })
})

/**
 * The case both other guards pass: a stale `whiteboard.db`.
 *
 * An operator who once ran the embedded database, later pointed
 * `WHITEBOARD_DATABASE_URL` at a libSQL server, and left the old file behind
 * defeats each of them for a different reason. The environment check reads
 * the invoking HOST shell, which never had the container's `--env-file`. The
 * artifact check finds a database file and is satisfied — it cannot tell a
 * live one from a fossil. The result is a backup of pre-migration rows,
 * reported as a success.
 *
 * Nothing observable at backup time contradicts it, so something has to have
 * been written down earlier, by the process that actually opened the
 * database. That is what `storage.json` is. It survives shutdown on purpose:
 * `server-mode.json` — the other thing this command reads — is deleted by
 * graceful shutdown, which the documented flow performs first, so it is
 * always already gone by the time a backup runs.
 */
describe('runServerBackup with a stale database file left behind', () => {
  it('keeps the fossil out on a clean host shell, on the record alone', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    // Every observable signal points at a healthy local database…
    await writeFile(join(dataDir, 'whiteboard.db'), 'pre-migration rows')
    // …except the one the server itself wrote when it last opened one.
    await writeDatabaseLocationRecord(dataDir, false)

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      // The host shell, exactly as the Docker how-to leaves it.
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.result.stores.database).toEqual({
      captured: false,
      reason: 'hosted-elsewhere',
    })
    expect(mockDoBackup.mock.calls[0][2]).toMatchObject({ excludeDatabaseFile: true })
  })

  /**
   * The record is the authority in BOTH directions, or it would be a guard
   * that only ever refuses. A deployment using the embedded database records
   * that, and a clean host shell must not then override it.
   */
  it('proceeds when the record says the rows are here and the shell disagrees', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')
    await writeDatabaseLocationRecord(dataDir, true)

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      // The two sources in conflict, which is the only arrangement that can
      // show the record is consulted at all: an operator whose shell exports
      // the variable for a DIFFERENT deployment. A clean env would agree with
      // the record for its own reason and prove nothing.
      env: { WHITEBOARD_DATABASE_URL: 'libsql://other.example.com' },
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoBackup).toHaveBeenCalledTimes(1)
  })

  /**
   * A record claiming the rows are here does not excuse them being gone. The
   * artifact check stays in force underneath it — the record answers WHERE,
   * never WHETHER.
   */
  it('still refuses when the record says here but no database file exists', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeDatabaseLocationRecord(dataDir, true)

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('missing-database')
    expect(mockDoBackup).not.toHaveBeenCalled()
  })
})

/**
 * ADR-0021 decision 2: a database we do not host is not ours to back up, and
 * we say so — rather than refusing to back up anything at all.
 *
 * The refusal above was the right first move and the wrong resting place. It
 * protects the rows by declining to pretend they were copied, but it also
 * declines to copy the BLOBS, which are ours and which no libSQL provider is
 * looking at. An operator who moved their rows to Turso currently has no way
 * to back up their images through this product at all, and the guard that
 * protects them from a misleading backup is what took it away.
 *
 * So the answer becomes per store: the database is reported out of scope, the
 * blobs are copied, and the output says which is which. The invariant the
 * refusal was protecting is unchanged and is now carried by the report — a
 * backup is never presented as holding rows it does not hold.
 */
describe('runServerBackup when the rows are not ours to back up', () => {
  const externalEnv = { WHITEBOARD_DATABASE_URL: 'libsql://db.example.com' }

  it('backs the blobs up instead of refusing everything', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(join(dataDir, 'blobs'), { recursive: true })

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: externalEnv,
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoBackup).toHaveBeenCalledTimes(1)
  })

  /**
   * The report is what now carries the invariant the refusal used to. An
   * operator must not be able to read this as "everything is safe", so the
   * database's absence is stated rather than left to be inferred from a
   * missing key.
   */
  it('reports the database as out of scope rather than claiming a whole backup', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(join(dataDir, 'blobs'), { recursive: true })

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: externalEnv,
      doBackup: async () => {},
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.result.stores.database).toEqual({
      captured: false,
      reason: 'hosted-elsewhere',
    })
    expect(outcome.result.stores.blobs).toEqual({ captured: true })
  })

  it('says the database is captured when it is ours', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: async () => {},
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.result.stores.database).toEqual({ captured: true })
  })

  /**
   * The one case that still refuses. "The rows belong in this directory" and
   * "the directory has no rows in it" cannot both be true of a working
   * deployment, so this is a broken data directory rather than a partial
   * backup, and copying it would produce something restore could not use.
   */
  it('still refuses when the rows should be in the directory and are not', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(join(dataDir, 'blobs'), { recursive: true })

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('missing-database')
    expect(mockDoBackup).not.toHaveBeenCalled()
  })
})

/**
 * The rows reach the backup as a SNAPSHOT, never as copied files (ADR-0021
 * decision 3).
 *
 * The two are not interchangeable. A file copy has to take `whiteboard.db`,
 * `-wal` and `-shm` together and get all three, because in WAL mode the
 * newest commits live in the `-wal` — measured at 4977 of 5000 rows when only
 * the main file travels. A snapshot is one self-contained file with
 * everything folded in, so a backup directory holds a plain `whiteboard.db`
 * and nothing downstream has to know sidecars exist.
 *
 * It is also the step that will let a backup be taken without stopping the
 * server, since it opens its own connection rather than reading bytes out
 * from under one.
 */
describe('runServerBackup captures the rows through the database', () => {
  it('snapshots the database and keeps its files out of the copy', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const mockDoBackup = vi.fn(async () => {})
    const mockDoSnapshot = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: mockDoSnapshot,
    })

    expect(outcome.kind).toBe('ok')
    // The copy never carries the database, even when it is ours — the
    // snapshot is what carries it.
    expect(mockDoBackup.mock.calls[0][2]).toMatchObject({ excludeDatabaseFile: true })
    // Into the staging directory, for the same reason the copy goes there.
    expect(mockDoSnapshot).toHaveBeenCalledWith(
      dataDir,
      join(`${outputDir}.incomplete`, 'whiteboard.db'),
    )
  })

  it('takes no snapshot of a database that is not ours', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(join(dataDir, 'blobs'), { recursive: true })

    const mockDoSnapshot = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: { WHITEBOARD_DATABASE_URL: 'libsql://db.example.com' },
      doBackup: async () => {},
      doSnapshot: mockDoSnapshot,
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoSnapshot).not.toHaveBeenCalled()
  })

  /**
   * A snapshot that fails must fail the backup. Reporting `ok` over a
   * directory holding blobs and no rows is the defect this whole area exists
   * to remove, and it would arrive here by simply not checking.
   */
  it('fails the backup when the snapshot cannot be taken', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: async () => {},
      doSnapshot: async () => {
        throw new Error('database is locked')
      },
    })

    expect(outcome.kind).toBe('error')
  })
})

/**
 * ADR-0021 decision 3's point: a backup that requires downtime is one an
 * operator takes rarely or never, and the interval between backups is the
 * data they lose. So a running server stops being a refusal.
 *
 * Two things had to be true first, and both now are. The rows are captured
 * through the database rather than by reading its bytes out from under it,
 * and file-GC stands down for the duration — because a backup is a snapshot
 * plus a copy, two moments, and a pass unlinking between them removes a file
 * the snapshot still references.
 */
describe('runServerBackup against a running server', () => {
  it('backs up rather than refusing, now that the rows are snapshotted', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: mockDoBackup,
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoBackup).toHaveBeenCalledTimes(1)
  })

  /**
   * The marker is what makes it safe, so it has to be in place while the work
   * happens — not merely written at some point.
   */
  it('holds the file-GC stand-down marker across the whole backup', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    let markerDuringCopy = false
    let markerDuringSnapshot = false
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: async () => {
        markerDuringCopy = await backupIsInProgress(dataDir)
      },
      doSnapshot: async () => {
        markerDuringSnapshot = await backupIsInProgress(dataDir)
      },
    })

    expect(outcome.kind).toBe('ok')
    expect(markerDuringCopy).toBe(true)
    expect(markerDuringSnapshot).toBe(true)
    // And released afterwards, or GC never runs again.
    expect(await backupIsInProgress(dataDir)).toBe(false)
  })

  it('releases the marker when the backup fails', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      doBackup: async () => {
        throw new Error('copy blew up')
      },
      doSnapshot: async () => {},
    })

    expect(outcome.kind).toBe('error')
    expect(await backupIsInProgress(dataDir)).toBe(false)
  })
})
