import { roundtrip } from '@kamiazya/whiteboard-daemon-client/api-contracts/roundtrip.test-helper'
import { describe, expect, it } from 'vitest'
import { type ServerStatusResult, serverStatusResultSchema } from './server-status.js'

describe('serverStatusResultSchema', () => {
  it('round-trips a running result, with every field an operator scripts against', () => {
    const value: ServerStatusResult = {
      schemaVersion: 1,
      ok: true,
      state: 'running',
      pid: 4242,
      host: '0.0.0.0',
      port: 8787,
      publicBaseUrl: 'https://board.example.com',
      authStrategy: 'oauth-jwt',
      startedAt: '2026-09-21T00:00:00.000Z',
      recordFresh: true,
    }
    expect(roundtrip(serverStatusResultSchema, value)).toEqual(value)
  })

  it.each([
    'missing',
    'stale',
    'malformed',
    'unverifiable',
  ] as const)('round-trips the %s result, which carries no record fields at all', (state) => {
    const value: ServerStatusResult = {
      schemaVersion: 1,
      ok: false,
      state,
      recordFresh: false,
    }
    expect(roundtrip(serverStatusResultSchema, value)).toEqual(value)
  })

  it('refuses a running arm that is missing what makes it useful', () => {
    // `host`/`port`/`publicBaseUrl` are the whole reason to ask; an arm
    // that says `running` without them is what the binding exists to stop.
    expect(() =>
      serverStatusResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        state: 'running',
        pid: 1,
        recordFresh: true,
      }),
    ).toThrow()
  })

  it('refuses `ok: true` paired with a not-running state', () => {
    expect(() =>
      serverStatusResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        state: 'stale',
        recordFresh: true,
      }),
    ).toThrow()
  })

  it('refuses a result WIDER than the contract, which is the class tsc cannot see', () => {
    // Spreading the server-mode record in would publish `instanceId`, which
    // the allow-list construction exists to leave out. TypeScript's
    // excess-property check does not apply to spread properties, so tsc
    // compiles that clean; `.strict()` is what refuses it.
    expect(() =>
      serverStatusResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        state: 'running',
        pid: 1,
        host: 'h',
        port: 1,
        publicBaseUrl: 'https://x',
        authStrategy: 'oauth-jwt',
        startedAt: '2026-09-21T00:00:00.000Z',
        recordFresh: true,
        instanceId: 'leaked',
      }),
    ).toThrow(/instanceId/)
  })

  it('refuses a state nobody declared, and a wrong schemaVersion', () => {
    expect(() =>
      serverStatusResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        state: 'exploded',
        recordFresh: false,
      }),
    ).toThrow()
    expect(() =>
      serverStatusResultSchema.parse({
        schemaVersion: 2,
        ok: false,
        state: 'missing',
        recordFresh: false,
      }),
    ).toThrow()
  })
})
