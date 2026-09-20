import { describe, expect, it, vi } from 'vitest'
import { ALL_AUTH_SCOPES } from './auth-strategy.js'
import { createCredentialResolver } from './credential-resolver.js'
import { mintMacaroon } from './macaroon.js'
import * as timingSafe from './timing-safe.js'

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

describe('createCredentialResolver — an open daemon does not swallow a ticket', () => {
  // `authorizeWsUpgrade` redeems an offered ticket before it reaches its own
  // "no token configured" shortcut, so the socket carries the ticket's own
  // narrower scopes. Answering `anonymous` first would widen that to
  // everything AND leave the ticket unburned — a silent widening on exactly
  // the configuration with the least else protecting it.
  it('redeems a ticket even with no daemon token configured', async () => {
    const redeemTicket = vi.fn(() => ({ scopes: ['canvas:read'] as const, clientId: 'client-c' }))
    const resolver = createCredentialResolver({ redeemTicket })

    expect(await resolver.resolve({ secret: 'tkt', carrier: 'ws-ticket' })).toEqual({
      kind: 'ws-ticket',
      scopes: ['canvas:read'],
      subject: 'client-c',
    })
    expect(redeemTicket).toHaveBeenCalledTimes(1)
  })

  it('still refuses a ticket that does not redeem, open daemon or not', async () => {
    const resolver = createCredentialResolver({ redeemTicket: () => null })

    expect(await resolver.resolve({ secret: 'tkt', carrier: 'ws-ticket' })).toBeNull()
  })

  it('leaves every other carrier anonymous on an open daemon', async () => {
    const resolver = createCredentialResolver({ redeemTicket: () => null })

    expect((await resolver.resolve(bearer('anything')))?.kind).toBe('anonymous')
    expect((await resolver.resolve({ secret: 'anything', carrier: 'ws-subprotocol' }))?.kind).toBe(
      'anonymous',
    )
  })
})

describe('createCredentialResolver — how the daemon token is compared', () => {
  // Followed the credential branch here from `ws-auth.test.ts`. The invariant
  // is unchanged and still worth pinning: a secret compared with `!==` leaks
  // its length and a prefix through timing, and the shared helper is the one
  // place that is handled.
  it('goes through the shared timing-safe helper, not a plain !==', async () => {
    const spy = vi.spyOn(timingSafe, 'timingSafeEqualStrings')
    try {
      const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN })
      await resolver.resolve(bearer(DAEMON_TOKEN))

      expect(spy).toHaveBeenCalledWith(DAEMON_TOKEN, DAEMON_TOKEN)
    } finally {
      spy.mockRestore()
    }
  })

  it('uses it for a wrong secret too, so the refusal path is no faster to probe', async () => {
    const spy = vi.spyOn(timingSafe, 'timingSafeEqualStrings')
    try {
      const resolver = createCredentialResolver({ daemonToken: DAEMON_TOKEN })
      await resolver.resolve(bearer('wrong-but-same-length!'))

      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createCredentialResolver — an open daemon still identifies a real credential', () => {
  // `anonymous` is a property of the DAEMON (no token configured), not a
  // verdict on the secret. Answering it before trying the specific branches
  // made every presented credential unidentifiable, and `/api/ws-ticket` —
  // which must know WHICH OAuth grant is asking in order to bind a ticket to
  // its scopes and client — answered 401 on the configuration its own
  // end-to-end test uses.
  it('resolves a real OAuth token to its grant, not to anonymous', async () => {
    const resolver = createCredentialResolver({
      grantStore: {
        verifyAccessToken: (token) =>
          token === 'access-token'
            ? { grantId: 'g1', clientId: 'client-a', scopes: ['canvas:read'] }
            : null,
      },
    })

    expect(await resolver.resolve(bearer('access-token'))).toEqual({
      kind: 'oauth-grant',
      scopes: ['canvas:read'],
      subject: 'client-a',
    })
  })

  it('falls back to anonymous for a secret nothing identifies, and for none at all', async () => {
    const resolver = createCredentialResolver({
      grantStore: { verifyAccessToken: () => null },
    })

    expect((await resolver.resolve(bearer('unknown')))?.kind).toBe('anonymous')
    expect((await resolver.resolve(bearer(null)))?.kind).toBe('anonymous')
  })

  // The guard that makes the fallback safe: `isAuthorized` answers true for
  // ANY secret when no token is configured, so the daemon-token branch has to
  // be skipped entirely rather than relied on to say no.
  it('never reports a bearer as the daemon token when none is configured', async () => {
    const resolver = createCredentialResolver({})

    expect((await resolver.resolve(bearer('anything at all')))?.kind).toBe('anonymous')
  })
})
