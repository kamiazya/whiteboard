import { describe, expect, it } from 'vitest'
import { type DaemonRunReadyResult, daemonRunReadyResultSchema } from './daemon-run.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('daemonRunReadyResultSchema', () => {
  it('round-trips the ready payload', () => {
    const value: DaemonRunReadyResult = {
      schemaVersion: 1,
      ok: true,
      pid: 123,
      port: 3099,
      host: '127.0.0.1',
      version: '1.2.3',
      startedAt: '2024-06-01T00:00:00.000Z',
    }
    expect(roundtrip(daemonRunReadyResultSchema, value)).toEqual(value)
  })

  it('rejects ok: false', () => {
    expect(() =>
      daemonRunReadyResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        pid: 123,
        port: 3099,
        host: '127.0.0.1',
        version: '1.2.3',
        startedAt: '2024-06-01T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      daemonRunReadyResultSchema.parse({
        schemaVersion: 2,
        ok: true,
        pid: 123,
        port: 3099,
        host: '127.0.0.1',
        version: '1.2.3',
        startedAt: '2024-06-01T00:00:00.000Z',
      }),
    ).toThrow()
  })
})
