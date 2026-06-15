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
