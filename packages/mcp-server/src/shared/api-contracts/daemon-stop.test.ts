import { roundtrip } from '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper'
import { describe, expect, it } from 'vitest'
import { type DaemonStopResult, daemonStopResultSchema } from './daemon-stop.js'

describe('daemonStopResultSchema', () => {
  it('round-trips a stopped result', () => {
    const value: DaemonStopResult = {
      schemaVersion: 1,
      ok: true,
      action: 'stopped',
      reason: null,
      pid: 123,
    }
    expect(roundtrip(daemonStopResultSchema, value)).toEqual(value)
  })

  it('round-trips a not-running result with pid:null', () => {
    const value: DaemonStopResult = {
      schemaVersion: 1,
      ok: false,
      action: 'not-running',
      reason: 'record-not-found',
      pid: null,
    }
    expect(roundtrip(daemonStopResultSchema, value)).toEqual(value)
  })

  it('round-trips a refused result', () => {
    const value: DaemonStopResult = {
      schemaVersion: 1,
      ok: false,
      action: 'refused',
      reason: 'kill-failed',
      pid: 123,
    }
    expect(roundtrip(daemonStopResultSchema, value)).toEqual(value)
  })

  it('rejects an invalid action', () => {
    expect(() =>
      daemonStopResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        action: 'exploded',
        reason: null,
        pid: null,
      }),
    ).toThrow()
  })

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      daemonStopResultSchema.parse({
        schemaVersion: 2,
        ok: true,
        action: 'stopped',
        reason: null,
        pid: 1,
      }),
    ).toThrow()
  })

  it('refuses a result widened past the contract — the class tsc cannot see', () => {
    // A result assembled with a SPREAD compiles clean however wide it is:
    // TypeScript's excess-property check does not apply to spread
    // properties. `.strict()` is the only thing between that and stdout.
    expect(() =>
      daemonStopResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        action: 'stopped',
        reason: null,
        pid: 1,
        token: 'leaked',
      }),
    ).toThrow(/token/)
  })
})
