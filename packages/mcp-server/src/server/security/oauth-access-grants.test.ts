import { describe, expect, it } from 'vitest'
import { createOAuthTransactionStore } from './oauth-authz-transactions.js'

describe('access-grant store', () => {
  it('resolves a minted access token back to its granted scopes and client', () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read'], 'hosted-client')

    const grant = store.verifyAccessToken(accessToken)

    expect(grant).not.toBeNull()
    expect(grant?.clientId).toBe('hosted-client')
    expect(grant?.scopes).toEqual(['canvas:read'])
  })

  it('rejects a forged or unknown bearer', () => {
    const store = createOAuthTransactionStore()
    store.mintAccessToken(['canvas:read'], 'hosted-client')

    expect(store.verifyAccessToken('not-a-real-token')).toBeNull()
    expect(store.verifyAccessToken('')).toBeNull()
  })

  // A minted token is a fixed-length base64url string, so an over-long input
  // is never a real token — rejecting it early keeps a request from making the
  // daemon hash a megabyte of attacker input. (The return value is null either
  // way; the point of the guard is to skip the hash, which output alone can't
  // observe — hence the plain null assertion here.)
  it('rejects an over-long bearer', () => {
    const store = createOAuthTransactionStore()
    expect(store.verifyAccessToken('a'.repeat(4096))).toBeNull()
  })

  it('rejects an expired grant', () => {
    let clock = 1_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { accessToken, expiresIn } = store.mintAccessToken(['canvas:read'], 'hosted-client')

    clock += expiresIn * 1000 + 1

    expect(store.verifyAccessToken(accessToken)).toBeNull()
  })

  it('reclaims expired grants on the next write instead of retaining them', () => {
    let clock = 1_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { expiresIn } = store.mintAccessToken(['canvas:read'], 'hosted-client')
    expect(store.size().grants).toBe(1)

    clock += expiresIn * 1000 + 1
    store.mintAccessToken(['canvas:read'], 'other-client')

    expect(store.size().grants).toBe(1)
  })

  it('rejects a revoked grant', () => {
    const store = createOAuthTransactionStore()
    const { accessToken } = store.mintAccessToken(['canvas:read'], 'hosted-client')
    const [grant] = store.listGrants('hosted-client')

    expect(store.revokeGrant(grant.grantId)).toBe(true)

    expect(store.verifyAccessToken(accessToken)).toBeNull()
    expect(store.revokeGrant(grant.grantId)).toBe(false)
    expect(store.listGrants('hosted-client')).toEqual([])
  })

  it('enumerates only the requesting client’s live grants, and never the token', () => {
    const clock = 1_000
    const store = createOAuthTransactionStore({ now: () => clock })
    store.mintAccessToken(['canvas:read'], 'client-a')
    store.mintAccessToken(['canvas:read', 'canvas:write'], 'client-b')

    const grantsForA = store.listGrants('client-a')

    expect(grantsForA).toHaveLength(1)
    expect(grantsForA[0]).toEqual({
      grantId: expect.any(String),
      clientId: 'client-a',
      scopes: ['canvas:read'],
      issuedAt: clock,
      expiresAt: expect.any(Number),
    })
    expect(JSON.stringify(grantsForA)).not.toContain('token')
    expect(store.listGrants('client-b')).toHaveLength(1)
    expect(store.listGrants('nobody')).toEqual([])
  })

  it('does not list a grant that has expired', () => {
    let clock = 1_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { expiresIn } = store.mintAccessToken(['canvas:read'], 'client-a')

    clock += expiresIn * 1000 + 1

    expect(store.listGrants('client-a')).toEqual([])
  })
})
