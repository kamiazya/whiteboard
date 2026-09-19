import { describe, expect, it, vi } from 'vitest'
import { ALL_AUTH_SCOPES } from './auth-strategy.js'
import { createCredentialResolver } from './credential-resolver.js'
import { mintMacaroon } from './macaroon.js'

const DAEMON_TOKEN = 'the-daemon-token'
const ROOT_KEY = new Uint8Array(32).fill(7)
const OTHER_ROOT_KEY = new Uint8Array(32).fill(8)
const ORIGIN = 'https://app.example.com'

const bearer = (secret: string | null, origin?: string) =>
  ({ secret, carrier: 'bearer', origin }) as const

describe('createCredentialResolver — what each credential carries', () => {
  it('answers anonymous with full authority when no daemon token is configured', async () => {
    const resolver = createCredentialResolver({})

    // Whatever is presented, including nothing: an open daemon is open.
    expect(await resolver.resolve(bearer(null))).toEqual({
      kind: 'anonymous',
      scopes: ALL_AUTH_SCOPES,
    })
    expect(await resolver.resolve(bearer('anything'))).toEqual({
      kind: 'anonymous',
      scopes: ALL_AUTH_SCOPES,
    })
  })

  it('answers the daemon token with full authority', async () => {
    const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN })

    expect(await resolver.resolve(bearer(DAEMON_TOKEN))).toEqual({
      kind: 'daemon-token',
      scopes: ALL_AUTH_SCOPES,
    })
  })

  it('answers null for a wrong secret and for no secret at all', async () => {
    const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN })

    expect(await resolver.resolve(bearer('nope'))).toBeNull()
    expect(await resolver.resolve(bearer(null))).toBeNull()
  })

  it('answers an OAuth grant with the scopes that grant holds, never the full set', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      grantStore: {
        verifyAccessToken: (token) =>
          token === 'access-token'
            ? { grantId: 'g1', clientId: 'client-a', scopes: ['canvas:read'] }
            : null,
      },
    })

    const grant = await resolver.resolve(bearer('access-token'))

    expect(grant).toEqual({
      kind: 'oauth-grant',
      scopes: ['canvas:read'],
      subject: 'client-a',
    })
    expect(grant?.scopes).not.toEqual(ALL_AUTH_SCOPES)
  })

  it('honours a pairing token only with the origin it was minted for', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      pairingTokens: { validate: (token, origin) => token === 'paired' && origin === ORIGIN },
    })

    expect(await resolver.resolve(bearer('paired', ORIGIN))).toEqual({
      kind: 'pairing',
      scopes: ALL_AUTH_SCOPES,
    })
    // Originless and cross-origin both fail: the Origin header is the browser's
    // own, and a pairing token presented without it is a token out of its lane.
    expect(await resolver.resolve(bearer('paired'))).toBeNull()
    expect(await resolver.resolve(bearer('paired', 'https://evil.example.com'))).toBeNull()
  })

  it('answers a macaroon with its caveated scopes', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      macaroonRootKey: ROOT_KEY,
    })
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    expect(await resolver.resolve(bearer(token))).toEqual({
      kind: 'macaroon',
      scopes: ['canvas:read'],
    })
  })

  it('refuses a macaroon under a foreign key, and an expired one', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      macaroonRootKey: ROOT_KEY,
    })
    const foreign = await mintMacaroon({
      rootKey: OTHER_ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    const expired = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [
        { kind: 'scope', scopes: ['canvas:read'] },
        { kind: 'expiresAt', epochMs: 0 },
      ],
    })

    expect(await resolver.resolve(bearer(foreign))).toBeNull()
    expect(await resolver.resolve(bearer(expired))).toBeNull()
  })
})

// The reason `carrier` is on the input at all. A ws connection ticket is
// SINGLE-USE, so a resolver that tried the ticket branch on every secret would
// burn a live ticket whenever one happened to be presented as something else —
// and burn it on a request that was never claiming to be a ticket.
describe('createCredentialResolver — a single-use ticket is only tried when offered as one', () => {
  it('redeems a ticket offered on the ticket carrier and carries its grant scopes', async () => {
    const redeemTicket = vi.fn((t: string) =>
      t === 'tkt' ? { scopes: ['canvas:read'] as const, clientId: 'client-b' } : null,
    )
    const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN, redeemTicket })

    expect(await resolver.resolve({ secret: 'tkt', carrier: 'ws-ticket' })).toEqual({
      kind: 'ws-ticket',
      scopes: ['canvas:read'],
      subject: 'client-b',
    })
    expect(redeemTicket).toHaveBeenCalledTimes(1)
  })

  it('never reaches the ticket store for a secret presented on another carrier', async () => {
    const redeemTicket = vi.fn(() => ({ scopes: ['canvas:read'] as const, clientId: 'client-b' }))
    const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN, redeemTicket })

    expect(await resolver.resolve(bearer('tkt'))).toBeNull()
    expect(await resolver.resolve({ secret: 'tkt', carrier: 'ws-subprotocol' })).toBeNull()
    expect(redeemTicket).not.toHaveBeenCalled()
  })

  it('does not fall through to the other credentials when a ticket does not redeem', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      redeemTicket: () => null,
    })

    // Even the daemon token itself, offered on the ticket carrier, is a
    // malformed offer rather than a credential to fall back on.
    expect(await resolver.resolve({ secret: DAEMON_TOKEN, carrier: 'ws-ticket' })).toBeNull()
  })
})

describe('createCredentialResolver — branch order is a cost decision', () => {
  it('answers the daemon token without paying for macaroon verification', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      // A root key that would throw if the macaroon branch were reached.
      macaroonRootKey: ROOT_KEY,
      pairingTokens: {
        validate: () => {
          throw new Error('pairing branch must not be reached for the daemon token')
        },
      },
    })

    expect((await resolver.resolve(bearer(DAEMON_TOKEN)))?.kind).toBe('daemon-token')
  })

  it('carries no branch a composition root did not configure', async () => {
    const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN })
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'agent-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    // No root key configured, so a macaroon is just an unknown secret.
    expect(await resolver.resolve(bearer(token))).toBeNull()
  })
})
