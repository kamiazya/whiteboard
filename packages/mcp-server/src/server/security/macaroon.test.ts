import { describe, expect, it } from 'vitest'
import {
  attenuateMacaroon,
  hmacSha256,
  type MacaroonCaveat,
  mintMacaroon,
  parseMacaroon,
  serializeMacaroon,
  verifyMacaroon,
} from './macaroon.js'

const ROOT_KEY = new Uint8Array(32).fill(7)
const OTHER_ROOT_KEY = new Uint8Array(32).fill(9)

const NOW = 1_700_000_000_000

function context(overrides: Partial<Parameters<typeof verifyMacaroon>[0]['context']> = {}) {
  return {
    workspaceId: 'ws-alpha',
    requiredScopes: [] as const,
    now: NOW,
    ...overrides,
  }
}

describe('macaroon — attenuation is one-way', () => {
  it('rejects a scope the caveats do not cover', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    await expect(
      verifyMacaroon({
        token,
        rootKey: ROOT_KEY,
        context: context({ requiredScopes: ['canvas:write'] }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'caveat-unsatisfied', caveat: 'scope' })
  })

  it('accepts a scope the caveats do cover', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read', 'canvas:write'] }],
    })

    await expect(
      verifyMacaroon({
        token,
        rootKey: ROOT_KEY,
        context: context({ requiredScopes: ['canvas:write'] }),
      }),
    ).resolves.toEqual({ ok: true, tokenId: 'tok-1', scopes: ['canvas:read', 'canvas:write'] })
  })

  // The whole point of the HMAC chain: a holder can add, and cannot take away.
  // Stripping needs sig(n-1), which HMAC does not yield from sig(n).
  it('does not verify once a caveat is stripped from a signed token', async () => {
    const token = await attenuateMacaroon(
      await mintMacaroon({ rootKey: ROOT_KEY, tokenId: 'tok-1' }),
      { kind: 'scope', scopes: ['canvas:read'] },
    )

    const stripped = parseMacaroon(token)
    expect(stripped?.caveats).toHaveLength(1)
    const forged = serializeMacaroon({ ...stripped!, caveats: [] })

    await expect(
      verifyMacaroon({ token: forged, rootKey: ROOT_KEY, context: context() }),
    ).resolves.toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('does not verify once a caveat is widened in place', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })

    const parsed = parseMacaroon(token)
    const widened: MacaroonCaveat = { kind: 'scope', scopes: ['canvas:read', 'runtime:admin'] }
    const forged = serializeMacaroon({ ...parsed!, caveats: [widened] })

    await expect(
      verifyMacaroon({ token: forged, rootKey: ROOT_KEY, context: context() }),
    ).resolves.toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('narrows further on each attenuation, conjunctively', async () => {
    const broad = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read', 'canvas:write'] }],
    })
    const narrow = await attenuateMacaroon(broad, { kind: 'scope', scopes: ['canvas:read'] })

    // The broad token still writes; the one derived from it no longer does.
    await expect(
      verifyMacaroon({
        token: broad,
        rootKey: ROOT_KEY,
        context: context({ requiredScopes: ['canvas:write'] }),
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      verifyMacaroon({
        token: narrow,
        rootKey: ROOT_KEY,
        context: context({ requiredScopes: ['canvas:write'] }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'caveat-unsatisfied', caveat: 'scope' })
  })

  it('cannot re-widen by attenuating with a superset', async () => {
    const narrow = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'scope', scopes: ['canvas:read'] }],
    })
    const attempt = await attenuateMacaroon(narrow, {
      kind: 'scope',
      scopes: ['canvas:read', 'canvas:write'],
    })

    await expect(
      verifyMacaroon({
        token: attempt,
        rootKey: ROOT_KEY,
        context: context({ requiredScopes: ['canvas:write'] }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'caveat-unsatisfied', caveat: 'scope' })
  })
})

describe('macaroon — the other caveats', () => {
  it('rejects a workspace the caveat does not name', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'workspace', workspaceId: 'ws-alpha' }],
    })

    await expect(
      verifyMacaroon({
        token,
        rootKey: ROOT_KEY,
        context: context({ workspaceId: 'ws-beta' }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'caveat-unsatisfied', caveat: 'workspace' })
  })

  it('rejects an expired token at the boundary', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [{ kind: 'expiresAt', epochMs: NOW }],
    })

    await expect(
      verifyMacaroon({ token, rootKey: ROOT_KEY, context: context({ now: NOW + 1 }) }),
    ).resolves.toEqual({ ok: false, reason: 'caveat-unsatisfied', caveat: 'expiresAt' })
    await expect(
      verifyMacaroon({ token, rootKey: ROOT_KEY, context: context({ now: NOW }) }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('macaroon — the root key', () => {
  it('does not verify under a different root key (rotation invalidates every token)', async () => {
    const token = await mintMacaroon({ rootKey: ROOT_KEY, tokenId: 'tok-1' })

    await expect(
      verifyMacaroon({ token, rootKey: OTHER_ROOT_KEY, context: context() }),
    ).resolves.toEqual({ ok: false, reason: 'bad-signature' })
  })
})

describe('macaroon — parsing is total', () => {
  it.each([
    ['not base64url at all', '!!!!'],
    ['base64url of not-JSON', Buffer.from('nope').toString('base64url')],
    ['JSON of the wrong shape', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
    ['an unknown caveat kind', ''],
  ])('answers null for %s rather than throwing', (label, raw) => {
    const value =
      label === 'an unknown caveat kind'
        ? Buffer.from(JSON.stringify({ id: 'x', caveats: [{ kind: 'nope' }], sig: 'AA' })).toString(
            'base64url',
          )
        : raw
    expect(parseMacaroon(value)).toBeNull()
  })

  it('round-trips a token through parse and serialize unchanged', async () => {
    const token = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-1',
      caveats: [
        { kind: 'workspace', workspaceId: 'ws-alpha' },
        { kind: 'scope', scopes: ['canvas:read'] },
      ],
    })

    expect(serializeMacaroon(parseMacaroon(token)!)).toBe(token)
  })
})

// A pinned construction, computed once and committed. It is NOT an external
// reference — libmacaroons' SERIALIZATION vectors cannot match this module's
// own JSON format, and the reference check that does apply is the
// construction one in the next describe. So this proves nothing about
// correctness against the literature. What it does catch is silent DRIFT:
// change a domain-separation tag, the `info` field order, the JSON-array
// encoding, or the chain's direction, and these values move.
//
// It exists because a mutation check found the hole: collapsing ROOT_TAG and
// CAVEAT_TAG into one value left all fourteen behavioural tests green. The
// tags are only defence in depth today (a root payload has two elements and a
// caveat payload three or more, so the JSON differs on arity whatever the tags
// say), and defence in depth that nothing pins is defence in depth that goes
// away in a refactor nobody reviews closely.
describe('macaroon — the construction is pinned against silent drift', () => {
  const sig = (token: string) => parseMacaroon(token)?.sig

  it('mints a known signature for a known root key and token id', async () => {
    expect(sig(await mintMacaroon({ rootKey: ROOT_KEY, tokenId: 'tok-golden' }))).toBe(
      '2zXTdwk5ksTSAzQexeWQhanw7tNF7L16-HWDmpe7RMs',
    )
  })

  it('advances the chain to a known signature for each caveat in turn', async () => {
    const withWorkspace = await attenuateMacaroon(
      await mintMacaroon({ rootKey: ROOT_KEY, tokenId: 'tok-golden' }),
      { kind: 'workspace', workspaceId: 'ws-alpha' },
    )
    expect(sig(withWorkspace)).toBe('O9f3PvT5NUGEy4m3Y_ACKNHIxXPFTtzD6CoYzSF32I0')

    const withScope = await attenuateMacaroon(withWorkspace, {
      kind: 'scope',
      scopes: ['canvas:read'],
    })
    expect(sig(withScope)).toBe('jGjU-SvrdXypbhChgoYEW181HXWCNE8SFJ0R7JSOf_k')
  })

  it('reaches the same signature by minting with the caveats as by attenuating', async () => {
    const minted = await mintMacaroon({
      rootKey: ROOT_KEY,
      tokenId: 'tok-golden',
      caveats: [
        { kind: 'workspace', workspaceId: 'ws-alpha' },
        { kind: 'scope', scopes: ['canvas:read'] },
      ],
    })

    expect(sig(minted)).toBe('jGjU-SvrdXypbhChgoYEW181HXWCNE8SFJ0R7JSOf_k')
  })
})

describe('macaroon — the construction matches the published reference', () => {
  // libmacaroons' README worked example. The same values appear in at least
  // six independent implementations (C, Java, JavaScript, C#, Python,
  // Erlang), which is what makes reproducing them an EXTERNAL check rather
  // than another way of asking this module whether it agrees with itself.
  //
  // It is deliberately narrow. This module does not use libmacaroons'
  // serialization and adds domain-separation tags its chain does not have, so
  // no vector can check a whole token. What it pins is that `hmacSha256` puts
  // the key and the message where the reference puts them — swap those two
  // arguments and all fourteen behavioural tests above still pass (measured),
  // because the chain stays one-way and nothing observable changes.
  //
  // The golden values above move under that swap too, so they would catch one
  // introduced later. The difference is that only this vector validates the
  // ORIGINAL choice: goldens taken from a born-swapped implementation would
  // be swapped goldens, and would agree with it forever.
  const SECRET = 'this is our super secret key; only we should know it'
  const IDENTIFIER = 'we used our secret key'
  // libmacaroons derives the chain's starting key from the secret rather than
  // using it raw; without this step the root signature is `5c748a4d…`.
  const KEY_GENERATOR = 'macaroons-key-generator'

  const utf8 = (value: string) => new TextEncoder().encode(value)
  const hex = (bytes: Uint8Array) =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const rootSignature = async () =>
    hmacSha256(await hmacSha256(utf8(KEY_GENERATOR), utf8(SECRET)), utf8(IDENTIFIER))

  it("reproduces libmacaroons' root signature", async () => {
    expect(hex(await rootSignature())).toBe(
      'e3d9e02908526c4c0039ae15114115d97fdd68bf2ba379b342aaf0f617d0552f',
    )
  })

  it("reproduces libmacaroons' signature after three first-party caveats", async () => {
    let signature = await rootSignature()
    for (const caveat of [
      'account = 3735928559',
      'time < 2020-01-01T00:00',
      'email = alice@example.org',
    ]) {
      signature = await hmacSha256(signature, utf8(caveat))
    }

    expect(hex(signature)).toBe('ddf553e46083e55b8d71ab822be3d8fcf21d6bf19c40d617bb9fb438934474b6')
  })
})
