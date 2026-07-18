import { describe, expect, it } from 'vitest'
import {
  reconnectCredentialResponseSchema as serverReconnectCredentialResponseSchema,
  reconnectSessionResponseSchema as serverReconnectSessionResponseSchema,
} from '../../../../packages/mcp-server/src/shared/api-contracts/reconnect.js'
import {
  reconnectCredentialResponseSchema,
  reconnectSessionResponseSchema,
} from './reconnect-client.js'

// Test-only deep import of the server's single source of truth for these two
// response shapes (packages/mcp-server/src/shared/api-contracts/reconnect.ts).
// reconnect-client.ts keeps its own mirror rather than importing that module
// at build time — reconnect.ts lives under src/server/routes originally, and
// even the relocated shared/api-contracts version stays off the published
// npm barrel, so reaching into mcp-server internals at build time would be a
// fragile, undocumented coupling. This test pins the mirror against silent
// field-level drift: a fixture either schema accepts must also be accepted
// by the other.
describe('reconnect-client schema drift pin', () => {
  it('a fixture accepted by the server reconnectCredentialResponseSchema is also accepted by the client mirror', () => {
    const serverFixture = { reconnectSecret: 'a-secret', expiresInDays: 30 }
    expect(serverReconnectCredentialResponseSchema.safeParse(serverFixture).success).toBe(true)
    expect(reconnectCredentialResponseSchema.safeParse(serverFixture).success).toBe(true)
  })

  it('a fixture accepted by the client reconnectCredentialResponseSchema is also accepted by the server schema', () => {
    const clientFixture = { reconnectSecret: 'client-secret', expiresInDays: 7 }
    expect(reconnectCredentialResponseSchema.safeParse(clientFixture).success).toBe(true)
    expect(serverReconnectCredentialResponseSchema.safeParse(clientFixture).success).toBe(true)
  })

  it('a fixture accepted by the server reconnectSessionResponseSchema (including the tokenless-daemon empty token) is also accepted by the client mirror', () => {
    const serverFixture = { token: '', reconnectSecret: 'rotated-secret', expiresInDays: 30 }
    expect(serverReconnectSessionResponseSchema.safeParse(serverFixture).success).toBe(true)
    expect(reconnectSessionResponseSchema.safeParse(serverFixture).success).toBe(true)
  })

  it('a fixture accepted by the client reconnectSessionResponseSchema is also accepted by the server schema', () => {
    const clientFixture = { token: 'tok', reconnectSecret: 'client-rotated', expiresInDays: 1 }
    expect(reconnectSessionResponseSchema.safeParse(clientFixture).success).toBe(true)
    expect(serverReconnectSessionResponseSchema.safeParse(clientFixture).success).toBe(true)
  })
})
