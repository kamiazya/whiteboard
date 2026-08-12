import { describe, expect, it, vi } from 'vitest'
import {
  challengeDaemonIdentity,
  createChallengeNonce,
  fingerprintPublicKey,
  getPinnedIdentity,
  pinIdentity,
  sha256Base64Url,
  verifyIdentitySignature,
} from './daemon-identity-pin.js'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

async function generateSigningPair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { pair, publicKey: jwk.x as string }
}

async function signParts(pair: CryptoKeyPair, parts: readonly string[]): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(parts))
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, payload)
  return bytesToBase64Url(new Uint8Array(signature))
}

describe('daemon identity pin store', () => {
  it('round-trips a pin per daemon baseUrl (trailing slash normalized)', () => {
    const storage = fakeStorage()
    pinIdentity('http://127.0.0.1:3099/', { alg: 'Ed25519', publicKey: 'key-a' }, storage)
    expect(getPinnedIdentity('http://127.0.0.1:3099', storage)).toMatchObject({
      alg: 'Ed25519',
      publicKey: 'key-a',
    })
    expect(getPinnedIdentity('http://127.0.0.1:3100', storage)).toBeNull()
  })

  it('a corrupt pin store degrades to no pins instead of throwing', () => {
    const storage = fakeStorage()
    storage.setItem('whiteboard:daemon-identity-pins', '{broken')
    expect(getPinnedIdentity('http://127.0.0.1:3099', storage)).toBeNull()
    // And re-pinning over the corrupt store works.
    pinIdentity('http://127.0.0.1:3099', { alg: 'Ed25519', publicKey: 'key-b' }, storage)
    expect(getPinnedIdentity('http://127.0.0.1:3099', storage)?.publicKey).toBe('key-b')
  })
})

describe('verifyIdentitySignature', () => {
  it('accepts a genuine signature and rejects a tampered message', async () => {
    const { pair, publicKey } = await generateSigningPair()
    const parts = ['wb-token-v1', createChallengeNonce(), 'https://app.example', 'hash', 'exp']
    const signature = await signParts(pair, parts)

    await expect(verifyIdentitySignature({ publicKey, parts, signature })).resolves.toBe(true)
    await expect(
      verifyIdentitySignature({ publicKey, parts: [...parts.slice(0, -1), 'other'], signature }),
    ).resolves.toBe(false)
  })

  it('rejects a signature from a DIFFERENT key (the squatter case)', async () => {
    const real = await generateSigningPair()
    const squatter = await generateSigningPair()
    const parts = ['wb-verify-v1', createChallengeNonce(), 'https://app.example']
    const forged = await signParts(squatter.pair, parts)
    await expect(
      verifyIdentitySignature({ publicKey: real.publicKey, parts, signature: forged }),
    ).resolves.toBe(false)
  })

  it('returns false (never throws) on malformed key material', async () => {
    await expect(
      verifyIdentitySignature({ publicKey: '!!!', parts: ['a'], signature: 'sig' }),
    ).resolves.toBe(false)
  })
})

describe('fingerprintPublicKey', () => {
  it('is deterministic, grouped XXXX-XXXX, and key-sensitive', async () => {
    const a = await generateSigningPair()
    const b = await generateSigningPair()
    const fpA = await fingerprintPublicKey(a.publicKey)
    expect(fpA).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(await fingerprintPublicKey(a.publicKey)).toBe(fpA)
    expect(await fingerprintPublicKey(b.publicKey)).not.toBe(fpA)
  })
})

describe('sha256Base64Url', () => {
  it('matches the daemon-side sha256 base64url encoding', async () => {
    // Known vector: sha256("abc") = ba7816bf... (base64url of raw digest)
    await expect(sha256Base64Url('abc')).resolves.toBe(
      'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
    )
  })
})

describe('challengeDaemonIdentity', () => {
  const BASE = 'http://127.0.0.1:3099'

  function pinsWith(publicKey: string) {
    const storage = fakeStorage()
    storage.setItem(
      'whiteboard:daemon-identity-pins',
      JSON.stringify({ [BASE]: { alg: 'Ed25519', publicKey, pinnedAt: 'then' } }),
    )
    return storage
  }

  it('resolves unpinned without ever fetching when no pin exists', async () => {
    const fetchFn = vi.fn()
    await expect(
      challengeDaemonIdentity({
        daemonBaseUrl: BASE,
        fetch: fetchFn as unknown as typeof globalThis.fetch,
        hostedOrigin: 'https://app.example',
        storage: fakeStorage(),
      }),
    ).resolves.toBe('unpinned')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('verifies a genuine challenge answer against the pin', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const publicKey = jwk.x as string
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const { nonce } = JSON.parse(String(init?.body)) as { nonce: string }
      const payload = new TextEncoder().encode(
        JSON.stringify(['wb-verify-v1', nonce, 'https://app.example']),
      )
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, payload),
      )
      const signature = btoa(String.fromCharCode(...sig))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '')
      return Response.json({ alg: 'Ed25519', publicKey, signature })
    })
    await expect(
      challengeDaemonIdentity({
        daemonBaseUrl: BASE,
        fetch: fetchFn as unknown as typeof globalThis.fetch,
        hostedOrigin: 'https://app.example',
        storage: pinsWith(publicKey),
      }),
    ).resolves.toBe('verified')
  })

  it('fails when the verify response drifts from the schema (alg change or extra field)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const publicKey = jwk.x as string
    const storage = pinsWith(publicKey)

    async function respondingWith(overrides: Record<string, unknown>) {
      const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
        const { nonce } = JSON.parse(String(init?.body)) as { nonce: string }
        const payload = new TextEncoder().encode(
          JSON.stringify(['wb-verify-v1', nonce, 'https://app.example']),
        )
        const sig = new Uint8Array(
          await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, payload),
        )
        const signature = btoa(String.fromCharCode(...sig))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '')
        return Response.json({ alg: 'Ed25519', publicKey, signature, ...overrides })
      })
      return challengeDaemonIdentity({
        daemonBaseUrl: BASE,
        fetch: fetchFn as unknown as typeof globalThis.fetch,
        hostedOrigin: 'https://app.example',
        storage,
      })
    }

    // A genuinely-signed response is still rejected once the alg field
    // drifts: a real signature under a changed algorithm must not read as
    // 'verified' just because the key and signature bytes check out.
    await expect(respondingWith({ alg: 'ES256' })).resolves.toBe('failed')
    await expect(respondingWith({ extra: 'unexpected' })).resolves.toBe('failed')
  })

  it('fails a pinned responder answering with another key, an error, or nothing', async () => {
    const squatter = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const squatterJwk = await crypto.subtle.exportKey('jwk', squatter.publicKey)
    const storage = pinsWith('PINNED-REAL-KEY')

    const wrongKey = vi.fn(async () =>
      Response.json({ alg: 'Ed25519', publicKey: squatterJwk.x, signature: 'sig' }),
    )
    await expect(
      challengeDaemonIdentity({
        daemonBaseUrl: BASE,
        fetch: wrongKey as unknown as typeof globalThis.fetch,
        hostedOrigin: 'https://app.example',
        storage,
      }),
    ).resolves.toBe('failed')

    const notFound = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(
      challengeDaemonIdentity({
        daemonBaseUrl: BASE,
        fetch: notFound as unknown as typeof globalThis.fetch,
        hostedOrigin: 'https://app.example',
        storage,
      }),
    ).resolves.toBe('failed')

    const network = vi.fn(async () => {
      throw new TypeError('unreachable')
    })
    await expect(
      challengeDaemonIdentity({
        daemonBaseUrl: BASE,
        fetch: network as unknown as typeof globalThis.fetch,
        hostedOrigin: 'https://app.example',
        storage,
      }),
    ).resolves.toBe('failed')
  })
})
