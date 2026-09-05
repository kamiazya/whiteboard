import { describe, expect, it } from 'vitest'
import { clientTextMessageSchema } from '../../shared/ws-messages.js'
import {
  hasRequiredScopes,
  requiredScopesForClientTextMessage,
  WS_BINARY_UPDATE_REQUIRED_SCOPES,
  WS_CLIENT_TEXT_MESSAGE_REQUIRED_SCOPES,
} from './ws-scope-registry.js'

// Discriminated-union options expose their literal `type` value as
// `.shape.type.value`, so the guard enumerates message types from the
// schema itself instead of a hand-kept list that could drift.
function discriminatedUnionLiterals(schema: typeof clientTextMessageSchema): string[] {
  return schema.options.map((option) => option.shape.type.value)
}

describe('ws-scope-registry — registry-wide coverage of client→server WS message types', () => {
  it('every clientTextMessageSchema union member has a registry entry', () => {
    const literals = discriminatedUnionLiterals(clientTextMessageSchema)
    expect(literals.length).toBeGreaterThan(0)
    const missing = literals.filter((type) => !(type in WS_CLIENT_TEXT_MESSAGE_REQUIRED_SCOPES))
    expect(missing, `no registry entry for WS message type(s): ${missing.join(', ')}`).toEqual([])
  })

  it('binary Loro updates require canvas:write', () => {
    expect(WS_BINARY_UPDATE_REQUIRED_SCOPES).toEqual(['canvas:write'])
  })

  it('every declared client text message type requires only canvas:read (none mutate directly)', () => {
    for (const [type, scopes] of Object.entries(WS_CLIENT_TEXT_MESSAGE_REQUIRED_SCOPES)) {
      expect(scopes, `unexpected scopes for ${type}`).toEqual(['canvas:read'])
    }
  })
})

describe('requiredScopesForClientTextMessage', () => {
  it('returns the registered scopes for a known type', () => {
    expect(requiredScopesForClientTextMessage('client_ready')).toEqual(['canvas:read'])
  })
})

describe('hasRequiredScopes', () => {
  it('true when every required scope is granted', () => {
    expect(hasRequiredScopes(['canvas:read', 'canvas:write'], ['canvas:write'])).toBe(true)
  })

  it('false when a required scope is missing', () => {
    expect(hasRequiredScopes(['canvas:read'], ['canvas:write'])).toBe(false)
  })

  it('true for an empty required-scopes list regardless of grants', () => {
    expect(hasRequiredScopes([], [])).toBe(true)
  })
})
