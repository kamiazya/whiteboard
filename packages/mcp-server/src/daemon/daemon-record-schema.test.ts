import { describe, expect, it } from 'vitest'
import { daemonRecordBaseSchema, daemonRecordSchema } from './daemon-record-schema.js'

describe('daemonRecordSchema', () => {
  it('parses a well-formed record', () => {
    const input = {
      pid: 123,
      port: 3099,
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }

    expect(daemonRecordSchema.parse(input)).toEqual(input)
  })

  it('strips unknown extra keys (forward compat) while keeping known fields', () => {
    const result = daemonRecordSchema.safeParse({
      pid: 123,
      port: 3099,
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
      futureField: 'ignored',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('futureField')
    }
  })

  it('rejects a record with a missing token', () => {
    const result = daemonRecordSchema.safeParse({
      pid: 123,
      port: 3099,
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })

    expect(result.success).toBe(false)
  })

  it('rejects a record with an empty-string token (fail-closed)', () => {
    const result = daemonRecordSchema.safeParse({
      pid: 123,
      port: 3099,
      token: '',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })

    expect(result.success).toBe(false)
  })

  it('rejects wrong-typed fields', () => {
    expect(
      daemonRecordSchema.safeParse({
        pid: '123',
        port: 3099,
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }).success,
    ).toBe(false)

    expect(
      daemonRecordSchema.safeParse({
        pid: 123,
        port: true,
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('rejects a negative, zero, or fractional pid/port (int().positive() enforcement)', () => {
    const validBase = {
      pid: 123,
      port: 3099,
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }

    expect(daemonRecordSchema.safeParse({ ...validBase, pid: -1 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, pid: 0 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, pid: 1.5 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, port: -1 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, port: 0 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, port: 1.5 }).success).toBe(false)
  })

  // TCP ports are 1-65535 (0 is reserved / "any port" and never a listening
  // daemon's own port). int().positive() alone lets a corrupt or malicious
  // daemon.json claim a port above the valid range.
  it('rejects a port above the valid TCP range (65535) and accepts the boundary value', () => {
    const validBase = {
      pid: 123,
      port: 3099,
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }

    expect(daemonRecordSchema.safeParse({ ...validBase, port: 65536 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, port: 65535 }).success).toBe(true)
  })

  it('rejects non-object input', () => {
    expect(daemonRecordSchema.safeParse([]).success).toBe(false)
    expect(daemonRecordSchema.safeParse(42).success).toBe(false)
    expect(daemonRecordSchema.safeParse(null).success).toBe(false)
  })

  it('daemonRecordBaseSchema (token-less) accepts a record without a token', () => {
    const result = daemonRecordBaseSchema.safeParse({
      pid: 123,
      port: 3099,
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })

    expect(result.success).toBe(true)
  })
})
