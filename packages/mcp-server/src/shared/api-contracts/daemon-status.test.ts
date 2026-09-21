import { roundtrip } from '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper'
import { describe, expect, it } from 'vitest'
import { type DaemonStatusResult, daemonStatusResultSchema } from './daemon-status.js'

describe('daemonStatusResultSchema', () => {
  it('round-trips record-not-found', () => {
    const value: DaemonStatusResult = {
      schemaVersion: 1,
      ok: false,
      reason: 'record-not-found',
      recordFound: false,
      recordFresh: false,
    }
    expect(roundtrip(daemonStatusResultSchema, value)).toEqual(value)
  })

  it('round-trips record-malformed', () => {
    const value: DaemonStatusResult = {
      schemaVersion: 1,
      ok: false,
      reason: 'record-malformed',
      recordFound: true,
      recordFresh: false,
    }
    expect(roundtrip(daemonStatusResultSchema, value)).toEqual(value)
  })

  it('round-trips token-missing with a record', () => {
    const value: DaemonStatusResult = {
      schemaVersion: 1,
      ok: false,
      reason: 'record-token-missing',
      recordFound: true,
      recordFresh: false,
      record: { pid: 123, port: 3099, version: '1.2.3', startedAt: '2024-06-01T00:00:00.000Z' },
    }
    expect(roundtrip(daemonStatusResultSchema, value)).toEqual(value)
  })

  it('round-trips process-not-running', () => {
    const value: DaemonStatusResult = {
      schemaVersion: 1,
      ok: false,
      reason: 'process-not-running',
      recordFound: true,
      recordFresh: false,
      pidAlive: false,
      record: { pid: 123, port: 3099, version: '1.2.3', startedAt: '2024-06-01T00:00:00.000Z' },
    }
    expect(roundtrip(daemonStatusResultSchema, value)).toEqual(value)
  })

  it('round-trips a full healthy record', () => {
    const value: DaemonStatusResult = {
      schemaVersion: 1,
      ok: true,
      reason: null,
      recordFound: true,
      recordFresh: true,
      pidAlive: true,
      pingOk: true,
      statusOk: true,
      record: { pid: 123, port: 3099, version: '1.2.3', startedAt: '2024-06-01T00:00:00.000Z' },
    }
    expect(roundtrip(daemonStatusResultSchema, value)).toEqual(value)
  })

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      daemonStatusResultSchema.parse({
        schemaVersion: 2,
        ok: true,
        reason: null,
        recordFound: true,
        recordFresh: true,
      }),
    ).toThrow()
  })

  it('rejects missing recordFound', () => {
    expect(() =>
      daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        reason: null,
        recordFresh: true,
      }),
    ).toThrow()
  })

  it('refuses a RESULT widened past the contract — the class tsc cannot see', () => {
    expect(() =>
      daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        reason: null,
        recordFound: true,
        recordFresh: true,
        daemonToken: 'leaked',
      }),
    ).toThrow(/daemonToken/)
  })

  it('refuses a record widened past the four fields the contract publishes — the class tsc cannot see', () => {
    // A result assembled with a SPREAD compiles clean however wide it is:
    // TypeScript's excess-property check does not apply to spread
    // properties. `.strict()` is the only thing between that and stdout.
    expect(() =>
      daemonStatusResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        reason: null,
        recordFound: true,
        recordFresh: true,
        record: {
          pid: 1,
          port: 2,
          version: 'v',
          startedAt: 's',
          dataDir: '/home/someone/.whiteboard',
        },
      }),
    ).toThrow(/dataDir/)
  })
})
