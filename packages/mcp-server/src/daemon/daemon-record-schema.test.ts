import { describe, expect, it } from 'vitest'
import { daemonRecordBaseSchema, daemonRecordSchema } from './daemon-record-schema.js'

describe('daemonRecordSchema', () => {
  it('parses a well-formed record', () => {
    const input = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }

    expect(daemonRecordSchema.parse(input)).toEqual(input)
  })

  it('strips unknown extra keys (forward compat) while keeping known fields', () => {
    const result = daemonRecordSchema.safeParse({
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
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
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })

    expect(result.success).toBe(false)
  })

  it('rejects a record with an empty-string token (fail-closed)', () => {
    const result = daemonRecordSchema.safeParse({
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
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
        socketPath: '/run/user/1000/whiteboard/d.sock',
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }).success,
    ).toBe(false)

    expect(
      daemonRecordSchema.safeParse({
        pid: 123,
        socketPath: true,
        token: 'secret',
        version: '0.1.0',
        startedAt: '2026-04-23T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('rejects a negative, zero, or fractional pid (int().positive() enforcement)', () => {
    const validBase = {
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      token: 'secret',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    }

    expect(daemonRecordSchema.safeParse({ ...validBase, pid: -1 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, pid: 0 }).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...validBase, pid: 1.5 }).success).toBe(false)
  })

  // ADR-0050: the socket is where a client reaches the daemon — it listens on
  // no port — so a record without one names a daemon nobody can reach.
  it('rejects a record naming no socket', () => {
    const { socketPath: _socketPath, ...noSocket } = {
      pid: 1,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.0.1',
      startedAt: '2026-01-01T00:00:00.000Z',
      token: 'x',
    }
    expect(daemonRecordSchema.safeParse(noSocket).success).toBe(false)
    expect(daemonRecordSchema.safeParse({ ...noSocket, socketPath: '' }).success).toBe(false)
  })

  it('rejects non-object input', () => {
    expect(daemonRecordSchema.safeParse([]).success).toBe(false)
    expect(daemonRecordSchema.safeParse(42).success).toBe(false)
    expect(daemonRecordSchema.safeParse(null).success).toBe(false)
  })

  it('daemonRecordBaseSchema (token-less) accepts a record without a token', () => {
    const result = daemonRecordBaseSchema.safeParse({
      pid: 123,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: '0.1.0',
      startedAt: '2026-04-23T00:00:00.000Z',
    })

    expect(result.success).toBe(true)
  })
})
