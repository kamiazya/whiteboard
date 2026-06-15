import { describe, expect, it } from 'vitest'
import { parseServerRestoreArgs } from './server-restore-args.js'

describe('parseServerRestoreArgs', () => {
  it('success: all required flags', () => {
    const r = parseServerRestoreArgs(['--json', '--backup-dir=/backup', '--target-dir=/target'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.json).toBe(true)
      expect(r.backupDir).toBe('/backup')
      expect(r.targetDir).toBe('/target')
    }
  })

  it('usage-error: --json missing', () => {
    const r = parseServerRestoreArgs(['--backup-dir=/backup', '--target-dir=/target'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/\/backup/)
      expect(r.message).not.toMatch(/\/target/)
    }
  })

  it('usage-error: --backup-dir missing', () => {
    const r = parseServerRestoreArgs(['--json', '--target-dir=/target'])
    expect(r.kind).toBe('usage-error')
  })

  it('usage-error: --target-dir missing', () => {
    const r = parseServerRestoreArgs(['--json', '--backup-dir=/backup'])
    expect(r.kind).toBe('usage-error')
  })

  it('usage-error: --backup-dir without = (space form)', () => {
    const r = parseServerRestoreArgs(['--json', '--backup-dir', '/backup', '--target-dir=/t'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/\/backup/)
    }
  })

  it('usage-error: --backup-dir duplicated — raw values not echoed', () => {
    const r = parseServerRestoreArgs([
      '--json',
      '--backup-dir=/a',
      '--backup-dir=/b',
      '--target-dir=/t',
    ])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/\/a/)
      expect(r.message).not.toMatch(/\/b/)
    }
  })

  it('usage-error: unknown flag does not echo its value', () => {
    const r = parseServerRestoreArgs([
      '--json',
      '--backup-dir=/b',
      '--target-dir=/t',
      '--unknown=secret',
    ])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).toContain('Unknown argument')
      expect(r.message).not.toMatch(/secret/)
      expect(r.message).toMatch(/--unknown=…/)
    }
  })

  it('usage-error: bare positional argument is redacted', () => {
    const r = parseServerRestoreArgs([
      '--json',
      '--backup-dir=/b',
      '--target-dir=/t',
      'bare-secret',
    ])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toMatch(/bare-secret/)
      expect(r.message).toMatch(/\[REDACTED_ARGUMENT\]/)
    }
  })

  it('usage-error: --target-dir= empty value', () => {
    const r = parseServerRestoreArgs(['--json', '--backup-dir=/b', '--target-dir='])
    expect(r.kind).toBe('usage-error')
  })
})
