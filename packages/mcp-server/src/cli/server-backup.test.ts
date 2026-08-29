import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { BackupError } from '../server/server-mode-backup-restore.js'
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

function makeRecord(overrides: Partial<ServerModeRecord> = {}): ServerModeRecord {
  return {
    schemaVersion: 1,
    pid: 99999,
    host: '127.0.0.1',
    port: 3099,
    publicBaseUrl: 'https://whiteboard.example.com',
    authStrategy: 'oauth-jwt',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.result).toMatchObject({
        schemaVersion: 1,
        ok: true,
        operation: 'backup',
      })
      // outputDir must NOT appear in success result (non-leak policy).
      expect(outcome.result).not.toHaveProperty('outputDir')
    }

    expect(capturedCalls).toHaveLength(1)
    const [src, dest, opts] = capturedCalls[0]
    expect(src).toBe(join(tmpRoot, 'data'))
    expect(dest).toBe(join(tmpRoot, 'backup'))

    // allowedRoots uses dirname(outputDir), NOT outputDir itself, so the
    // helper's assertWithinAllowed check is non-tautological.
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

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(async () => {}),
    })

    expect(outcome.kind).toBe('ok')
    // CLI must not pre-create the dir; the mock doBackup does not create it
    // either, so the directory must still be absent after the call.
    await expect(lstat(join(tmpRoot, 'new-backup'))).rejects.toThrow()
  })

  it('ancestor-symlink: path through a symlink ancestor is rejected (fail-closed)', async () => {
    const realOutside = join(tmpRoot, 'real-outside')
    const link = join(tmpRoot, 'link-to-real')
    await mkdir(realOutside)
    await symlink(realOutside, link)

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: join(link, 'backup'), dataDir: tmpRoot },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(),
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(async () => {
        throw new BackupError('Backup directory is not empty.')
      }),
    })

    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.message).not.toMatch(new RegExp(tmpRoot.replace(/[/\\]/g, '.')))
      expect(outcome.message).not.toMatch(/not empty/)
      expect(outcome.message).toBe('backup failed')
    }
  })

  it('running-server: live pid in server-mode.json causes backup to be refused', async () => {
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: join(tmpRoot, 'out'), dataDir: tmpRoot },
      env: {},
      isPidAlive: () => true,
      doReadRecord: () => ({ kind: 'ok', record: makeRecord({ pid: process.pid }) }),
      doBackup: vi.fn(),
    })

    expect(outcome.kind).toBe('running-server')
  })

  it('running-server: stale (dead) pid is not refused', async () => {
    const outputDir = join(tmpRoot, 'out')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir: tmpRoot },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'ok', record: makeRecord({ pid: 99999 }) }),
      doBackup: vi.fn(async () => {}),
    })

    expect(outcome.kind).not.toBe('running-server')
  })

  it('invalid-output-path: symlink output dir is rejected', async () => {
    const realDir = join(tmpRoot, 'real')
    const linkPath = join(tmpRoot, 'link')
    await mkdir(realDir)
    await symlink(realDir, linkPath)

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: linkPath, dataDir: tmpRoot },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(),
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(),
    })

    expect(outcome.kind).toBe('error')
  })

  it('invalid-output-path: plain file output is rejected', async () => {
    const filePath = join(tmpRoot, 'not-a-dir.txt')
    await writeFile(filePath, 'content')

    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir: filePath, dataDir: tmpRoot },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(),
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: vi.fn(async () => {
        throw new BackupError('some internal error with path /internal/detail')
      }),
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
  it('refuses rather than copying blobs alone and calling it a backup', async () => {
    const dataDir = join(tmpRoot, 'data')
    const outputDir = join(tmpRoot, 'backup')
    await mkdir(dataDir)
    // A data directory with no database is refused now (see the host-shell
    // case at the bottom of this file), so the happy paths seed one.
    await writeFile(join(dataDir, 'whiteboard.db'), 'rows')

    const mockDoBackup = vi.fn(async () => {})
    const outcome = await runServerBackup({
      args: { kind: 'ok', json: true, outputDir, dataDir },
      env: { WHITEBOARD_DATABASE_URL: 'libsql://db.example.com' },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
    })

    expect(outcome.kind).toBe('external-database')
    // Refused BEFORE copying: a half-backup left on disk is the thing an
    // operator would later restore from.
    expect(mockDoBackup).not.toHaveBeenCalled()
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
    })

    expect(outcome.kind).toBe('external-database')
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
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
  it('refuses when the recorded location says the rows are elsewhere', async () => {
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
    })

    expect(outcome.kind).toBe('external-database')
    expect(mockDoBackup).not.toHaveBeenCalled()
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
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
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doBackup: mockDoBackup,
    })

    expect(outcome.kind).toBe('external-database')
    expect(mockDoBackup).not.toHaveBeenCalled()
  })
})
