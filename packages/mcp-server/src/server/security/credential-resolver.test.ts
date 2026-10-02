import { describe, expect, it, vi } from 'vitest'
import { ALL_AUTH_SCOPES } from './auth-strategy.js'
import { createCredentialResolver } from './credential-resolver.js'
import * as macaroon from './macaroon.js'
import { mintMacaroon } from './macaroon.js'
import * as timingSafe from './timing-safe.js'

const DAEMON_TOKEN = 'the-daemon-token'
const ROOT_KEY = new Uint8Array(32).fill(7)
const OTHER_ROOT_KEY = new Uint8Array(32).fill(8)

const bearer = (secret: string | null) => ({ secret }) as const

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

describe('createCredentialResolver — branch order is a cost decision', () => {
  it('answers the daemon token without paying for macaroon verification', async () => {
    const resolver = createCredentialResolver({
      daemonToken: DAEMON_TOKEN,
      macaroonRootKey: ROOT_KEY,
    })
    const verify = vi.spyOn(macaroon, 'verifyMacaroon')
    try {
      expect((await resolver.resolve(bearer(DAEMON_TOKEN)))?.kind).toBe('daemon-token')
      expect(verify).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
    }
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

describe('createCredentialResolver — how the daemon token is compared', () => {
  // A secret compared with `!==` leaks its length and a prefix through
  // timing, and the shared helper is the one place that is handled.
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
  // verdict on the secret, so it is the fallback after every branch rather
  // than a shortcut before them.
  it('resolves a real macaroon to its grant, not to anonymous', async () => {
    const resolver = createCredentialResolver({ macaroonRootKey: ROOT_KEY })
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

  it('falls back to anonymous for a secret nothing identifies, and for none at all', async () => {
    const resolver = createCredentialResolver({ macaroonRootKey: ROOT_KEY })

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

  it('resolves no grant at all for an empty configured token, rather than opening the daemon', async () => {
    const resolver = createCredentialResolver({ daemonToken: '' })

    expect(await resolver.resolve(bearer('guess'))).toBeNull()
    expect(await resolver.resolve(bearer(''))).toBeNull()
    expect(await resolver.resolve(bearer(null))).toBeNull()
  })
})
