import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import type { BackupRestoreOptions } from '../server/server-mode-backup-restore.js'
import { BackupError } from '../server/server-mode-backup-restore.js'
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
