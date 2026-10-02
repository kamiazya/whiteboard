import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../shared/test-utils/fast-check.js'
import { parseDaemonSupportBundleArgs } from './argv.js'
import { parseServerSupportBundleArgs } from './support-bundle-args.js'

const FLAGS = [
  '--json',
  '--output-dir=/out',
  '--output-dir=',
  '--output-dir',
  '--data-dir=/data',
  '--data-dir=',
  '--data-dir',
  '--bogus',
  'bare',
] as const

describe('the daemon and server support-bundle commands share one flag grammar', () => {
  // Only the two sentences that name the command differ, so the property
  // compares what was ACCEPTED and which flag was refused, not the wording.
  fcTest.prop([fc.array(fc.constantFrom(...FLAGS), { maxLength: 5 })], withDefaults())(
    'accept the same arguments and answer the same fields',
    (args) => {
      const daemon = parseDaemonSupportBundleArgs(args)
      const server = parseServerSupportBundleArgs(args)
      expect(daemon.kind).toBe(server.kind)
      if (daemon.kind === 'ok' && server.kind === 'ok') expect(daemon).toEqual(server)
    },
  )
})

describe('parseServerSupportBundleArgs', () => {
  it('success: --json and --output-dir', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir=/tmp/bundle'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.json).toBe(true)
      expect(r.outputDir).toBe('/tmp/bundle')
      expect(r.dataDir).toBeUndefined()
    }
  })

  it('success: --json and --output-dir and optional --data-dir', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir=/out', '--data-dir=/data'])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.outputDir).toBe('/out')
      expect(r.dataDir).toBe('/data')
    }
  })

  it('usage-error: --json missing', () => {
    const r = parseServerSupportBundleArgs(['--output-dir=/out'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).toMatch(/--json/)
    }
  })

  it('usage-error: --output-dir missing', () => {
    const r = parseServerSupportBundleArgs(['--json'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).toMatch(/--output-dir/)
    }
  })

  it('usage-error: --output-dir space form (no inline =)', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir', '/out'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).toMatch(/inline form/)
    }
  })

  it('usage-error: --data-dir space form is rejected', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir=/out', '--data-dir', '/d'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).toMatch(/inline form/)
    }
  })

  it('usage-error: --output-dir= with empty value', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir='])
    expect(r.kind).toBe('usage-error')
  })

  it('usage-error: unknown flag does not echo its value', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir=/out', '--unknown=verysecret'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toContain('verysecret')
    }
  })

  it('usage-error: bare positional argument is redacted', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir=/out', 'bare-secret'])
    expect(r.kind).toBe('usage-error')
    if (r.kind === 'usage-error') {
      expect(r.message).not.toContain('bare-secret')
    }
  })

  it('usage-error: --output-dir specified more than once', () => {
    const r = parseServerSupportBundleArgs(['--json', '--output-dir=/a', '--output-dir=/b'])
    expect(r.kind).toBe('usage-error')
  })
})
