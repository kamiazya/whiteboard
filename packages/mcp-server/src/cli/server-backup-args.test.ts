import { describe, expect, it } from 'vitest'
import { parseServerBackupArgs } from './server-backup-args.js'

describe('parseServerBackupArgs', () => {
  it('success: --json and --output-dir', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir=/tmp/backup'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.json).toBe(true)
      expect(r.outputDir).toBe('/tmp/backup')
      expect(r.dataDir).toBeUndefined()
    }
  })

  it('success: --json and --output-dir and optional --data-dir', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir=/backup', '--data-dir=/data'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.outputDir).toBe('/backup')
      expect(r.dataDir).toBe('/data')
    }
  })

  /**
   * The flag that makes a scheduled backup share one blob mirror between its
   * retained runs. Absent, the backup keeps its mirror inside itself and
   * stays a directory an operator can carry — which is why this is a flag
   * rather than the default.
   */
  it('success: --mirror-dir points the blob mirror somewhere shared', () => {
    expect(
      parseServerBackupArgs([
        '--json',
        '--output-dir=/backups/2026-03-04T05-06-07.000Z',
        '--mirror-dir=/backups',
      ]),
    ).toEqual({
      kind: 'ok',
      json: true,
      outputDir: '/backups/2026-03-04T05-06-07.000Z',
      dataDir: undefined,
      mirrorDir: '/backups',
    })
  })

  /**
   * Absolute only, for the reason `WHITEBOARD_BACKUP_DIR` is: a relative path
   * resolves against a working directory the operator did not choose, so it
   * would mean one thing to them and land somewhere else.
   */
  it('usage-error: --mirror-dir must be absolute', () => {
    const parsed = parseServerBackupArgs([
      '--json',
      '--output-dir=/backups/one',
      '--mirror-dir=./m',
    ])
    expect(parsed.kind).toBe('usage-error')
  })

  it('usage-error: --mirror-dir duplicated', () => {
    const parsed = parseServerBackupArgs([
      '--json',
      '--output-dir=/backups/one',
      '--mirror-dir=/a',
      '--mirror-dir=/b',
    ])
    expect(parsed.kind).toBe('usage-error')
  })

  it('usage-error: --mirror-dir without = (space form)', () => {
    const parsed = parseServerBackupArgs(['--json', '--output-dir=/backups/one', '--mirror-dir'])
    expect(parsed.kind).toBe('usage-error')
  })

  it('usage-error: --json missing', () => {
    const r = parseServerBackupArgs(['--output-dir=/backup'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/\/backup/)
    }
  })

  it('usage-error: --output-dir missing', () => {
    const r = parseServerBackupArgs(['--json'])
    expect(r.kind).toBe('usage-error')
  })

  it('usage-error: --json duplicated', () => {
    const r = parseServerBackupArgs(['--json', '--json', '--output-dir=/backup'])
    expect(r.kind).toBe('usage-error')
  })

  it('usage-error: --output-dir duplicated', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir=/a', '--output-dir=/b'])
    expect(r.kind).toBe('usage-error')
    // Raw value must not be echoed
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/\/a/)
      expect(r.message).not.toMatch(/\/b/)
    }
  })

  it('usage-error: --output-dir without = (space form)', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir', '/backup'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/\/backup/)
    }
  })

  it('usage-error: unknown flag does not echo its value', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir=/b', '--unknown-flag=secret'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).toContain('Unknown argument')
      expect(r.message).not.toMatch(/secret/)
      expect(r.message).toMatch(/--unknown-flag=…/)
    }
  })

  it('usage-error: bare positional argument is redacted', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir=/b', 'positional-secret'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/positional-secret/)
      expect(r.message).toMatch(/\[REDACTED_ARGUMENT\]/)
    }
  })

  it('usage-error: --output-dir= empty value', () => {
    const r = parseServerBackupArgs(['--json', '--output-dir='])
    expect(r.kind).toBe('usage-error')
  })
})
