import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreDataDir } from '../server/backup-restore.js'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { BackupError } from '../server/server-mode-backup-restore.js'
import { writeDatabaseLocationRecord } from '../server/store/db/location-record.js'
import { runServerRestore } from './server-restore.js'

let tmpRoot: string

beforeEach(async () => {
  // Canonicalize via realpath so paths don't traverse system-level symlinks
  // (e.g. /var → /private/var on macOS) that would trip hasAncestorSymlink.
  tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'wb-server-restore-test-')))
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

describe('runServerRestore', () => {
  it('success: calls doRestore with resolved paths and non-tautological allowedRoots', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'restored')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const capturedCalls: [string, string, BackupRestoreOptions][] = []
    const mockDoRestore = vi.fn(
      async (backup: string, target: string, opts: BackupRestoreOptions) => {
        capturedCalls.push([backup, target, opts])
      },
    )

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: mockDoRestore,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.result).toMatchObject({
        schemaVersion: 1,
        ok: true,
        operation: 'restore',
      })
    }

    expect(capturedCalls).toHaveLength(1)
    const [backup, target, opts] = capturedCalls[0]
    expect(backup).toBe(join(tmpRoot, 'backup'))
    expect(target).toBe(join(tmpRoot, 'restored'))

    // allowedRoots uses dirname variants, NOT the paths themselves.
    expect(opts.allowedRoots).toContain(tmpRoot) // dirname of both paths
    expect(opts.allowedRoots).not.toContain(join(tmpRoot, 'backup')) // NOT self
    expect(opts.allowedRoots).not.toContain(join(tmpRoot, 'restored')) // NOT self
  })

  it('success: missing target dir is passed to helper (helper creates it via cp)', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'missing-target')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(async () => {}),
    })

    expect(outcome.kind).toBe('ok')
  })

  it('ancestor-symlink: path through a symlink ancestor is rejected (fail-closed)', async () => {
    const realOutside = join(tmpRoot, 'real-outside')
    const link = join(tmpRoot, 'link-to-real')
    const backupDir = join(tmpRoot, 'backup')
    await mkdir(realOutside)
    await symlink(realOutside, link)
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir: join(link, 'restored') },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(),
    })

    // Ancestor symlink must be rejected, not followed.
    expect(outcome.kind).toBe('invalid-target-path')
  })

  it('error: non-empty targetDir causes BackupError → generic error, no path leak', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'non-empty')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')
    await mkdir(targetDir)
    await writeFile(join(targetDir, 'canary.txt'), 'content')

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(async () => {
        throw new BackupError('Target data directory is not empty.')
      }),
    })

    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.message).not.toMatch(new RegExp(tmpRoot.replace(/[/\\]/g, '.')))
      expect(outcome.message).not.toMatch(/not empty/)
      expect(outcome.message).toBe('restore failed')
    }
  })

  it('running-target: live pid in server-mode.json causes restore to be refused', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'running-target')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')
    await mkdir(targetDir)

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      isPidAlive: () => true,
      doReadRecord: () => ({ kind: 'ok', record: makeRecord({ pid: process.pid }) }),
      doRestore: vi.fn(),
    })

    expect(outcome.kind).toBe('running-target')
  })

  it('running-target: stale (dead) pid does not block restore', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'target')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'ok', record: makeRecord({ pid: 99999 }) }),
      doRestore: vi.fn(async () => {}),
    })

    expect(outcome.kind).not.toBe('running-target')
  })

  it('invalid-target-path: symlink target dir is rejected', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const realDir = join(tmpRoot, 'real')
    const linkPath = join(tmpRoot, 'link')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')
    await mkdir(realDir)
    await symlink(realDir, linkPath)

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir: linkPath },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(),
    })

    expect(outcome.kind).toBe('invalid-target-path')
  })

  it('error: symlinked backupDir is rejected (fail-closed)', async () => {
    const realBackup = join(tmpRoot, 'real-backup')
    const link = join(tmpRoot, 'link-to-backup')
    await mkdir(realBackup)
    await symlink(realBackup, link)

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir: link, targetDir: join(tmpRoot, 'target') },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(),
    })

    expect(outcome.kind).toBe('error')
  })

  it('invalid-target-path: plain file target is rejected', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const filePath = join(tmpRoot, 'not-a-dir.txt')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')
    await writeFile(filePath, 'content')

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir: filePath },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(),
    })

    expect(outcome.kind).toBe('invalid-target-path')
  })

  it('non-leak: outcome does not contain raw paths or credentials', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'target')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: vi.fn(async () => {
        throw new BackupError(`some internal error with path ${tmpRoot}`)
      }),
    })

    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.message).not.toMatch(new RegExp(tmpRoot.replace(/[/\\]/g, '.')))
      expect(outcome.message).not.toMatch(/Bearer/i)
      expect(outcome.message).not.toMatch(/Authorization/i)
    }
  })
})

/**
 * The mirror of the backup guard. Restoring a whole-directory backup into a
 * data directory whose rows live elsewhere puts the blobs back and nothing
 * else, while reporting success — and the operator's next act is to start a
 * server against it.
 */
describe('runServerRestore with the database outside the data directory', () => {
  it('refuses rather than restoring blobs alone and calling it a restore', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'restored')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const mockDoRestore = vi.fn(async () => {})
    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      env: { WHITEBOARD_DATABASE_URL: 'libsql://db.example.com' },
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: mockDoRestore,
    })

    expect(outcome.kind).toBe('external-database')
    expect(mockDoRestore).not.toHaveBeenCalled()
  })

  it('still restores normally when the database is the data directory file', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'restored')
    await mkdir(backupDir)
    // A backup with no database cannot restore rows, so it is refused now;
    // the happy paths seed one.
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')

    const mockDoRestore = vi.fn(async () => {})
    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: mockDoRestore,
    })

    expect(outcome.kind).toBe('ok')
    expect(mockDoRestore).toHaveBeenCalledTimes(1)
  })
})

/**
 * The mirror of the backup case, and asked of the artifact for the same
 * reason: restore is also documented as a host-side command, so the
 * environment it reads may not be the deployment's.
 */
describe('runServerRestore judges from the backup directory, not the invoking shell', () => {
  it('refuses a backup that holds no database, even with a clean env', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'restored')
    await mkdir(join(backupDir, 'blobs'), { recursive: true })

    const mockDoRestore = vi.fn(async () => {})
    const outcome = await runServerRestore({
      args: { kind: 'ok', json: true, backupDir, targetDir },
      env: {},
      isPidAlive: () => false,
      doReadRecord: () => ({ kind: 'missing' }),
      doRestore: mockDoRestore,
    })

    expect(outcome.kind).toBe('external-database')
    expect(mockDoRestore).not.toHaveBeenCalled()
  })
})

/**
 * Why the location record is NOT consulted here, though the symmetry with
 * backup invites it.
 *
 * Restore requires the target to be empty or missing, so a target can never
 * be holding a record to read. A check for one would be unreachable in
 * production — and would pass a test suite like this one, because these tests
 * mock `doRestore`, which is where the emptiness rejection lives. This test
 * pins the reason so the symmetry is not "restored" later by someone reading
 * the two files side by side.
 */
describe('restore does not read a location record from its target', () => {
  it('rejects a target that holds one, because holding one makes it non-empty', async () => {
    const backupDir = join(tmpRoot, 'backup')
    const targetDir = join(tmpRoot, 'restored')
    await mkdir(backupDir, { recursive: true })
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(backupDir, 'whiteboard.db'), 'rows')
    // The only way a target could have a record: a previous deployment lived
    // here. That is exactly what the real restore refuses.
    await writeDatabaseLocationRecord(targetDir, false)

    await expect(restoreDataDir(backupDir, targetDir, { allowedRoots: [tmpRoot] })).rejects.toThrow(
      /not empty/i,
    )
  })
})
