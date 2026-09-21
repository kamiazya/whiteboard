import { roundtrip } from '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper'
import { describe, expect, it } from 'vitest'
import { type ServerStopResult, serverStopResultSchema } from './server-stop.js'

describe('serverStopResultSchema', () => {
  it('round-trips a stopped result, pid included so an operator can correlate', () => {
    const value: ServerStopResult = {
      schemaVersion: 1,
      ok: true,
      action: 'stopped',
      reason: null,
      recordFound: true,
      recordFresh: true,
      pid: 4242,
    }
    expect(roundtrip(serverStopResultSchema, value)).toEqual(value)
  })

  it('round-trips a not-running result, which carries no pid at all', () => {
    const value: ServerStopResult = {
      schemaVersion: 1,
      ok: true,
      action: 'not-running',
      reason: 'server-record-not-found',
      recordFound: false,
      recordFresh: false,
    }
    expect(roundtrip(serverStopResultSchema, value)).toEqual(value)
  })

  it('round-trips the refusal that protects a reused pid', () => {
    const value: ServerStopResult = {
      schemaVersion: 1,
      ok: false,
      action: 'refused',
      reason: 'server-instance-unverifiable',
      recordFound: true,
      recordFresh: true,
      pid: 7,
    }
    expect(roundtrip(serverStopResultSchema, value)).toEqual(value)
  })

  it('refuses a result WIDER than the contract, which is the class tsc cannot see', () => {
    // Every return funnels through one `outcome()` that SPREADS its
    // caller's object in, and TypeScript's excess-property check does not
    // apply to a spread. `.strict()` is what refuses a leaked field.
    expect(() =>
      serverStopResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        action: 'stopped',
        reason: null,
        recordFound: true,
        recordFresh: true,
        publicBaseUrl: 'https://leaked.example.com',
      }),
    ).toThrow(/publicBaseUrl/)
  })

  it('refuses an action or reason nobody declared', () => {
    const base = { schemaVersion: 1, ok: false, recordFound: true, recordFresh: true }
    expect(() =>
      serverStopResultSchema.parse({ ...base, action: 'exploded', reason: null }),
    ).toThrow()
    expect(() =>
      serverStopResultSchema.parse({ ...base, action: 'refused', reason: 'because' }),
    ).toThrow()
  })
})
