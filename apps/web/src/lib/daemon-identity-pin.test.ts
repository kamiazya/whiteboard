// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  challengeDaemonIdentity,
  createChallengeNonce,
  fingerprintPublicKey,
  pinIdentity,
  readPinnedIdentity,
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

function pinnedKey(base: string, storage: ReturnType<typeof fakeStorage>) {
  const pin = readPinnedIdentity(base, storage)
  return pin.kind === 'pinned' ? pin.pin.publicKey : pin.kind
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
    expect(pinnedKey('http://127.0.0.1:3099', storage)).toBe('key-a')
    expect(readPinnedIdentity('http://127.0.0.1:3100', storage)).toEqual({ kind: 'none' })
  })

  it('a corrupt pin store reads as unreadable, not as no pins, and can be re-pinned', () => {
    const storage = fakeStorage()
    storage.setItem('whiteboard:daemon-identity-pins', '{broken')
    expect(readPinnedIdentity('http://127.0.0.1:3099', storage)).toEqual({ kind: 'unreadable' })
    // Re-pinning (the user's own consent on /pair) still works over it.
    pinIdentity('http://127.0.0.1:3099', { alg: 'Ed25519', publicKey: 'key-b' }, storage)
    expect(pinnedKey('http://127.0.0.1:3099', storage)).toBe('key-b')
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

describe('a pin store holding an entry this build cannot read', () => {
  // A NEWER build may add a field to a pin; `.strict()` in an OLDER tab still
  // open reads that one entry as unreadable. It must cost that entry, not
  // every daemon's pin — and pinning another daemon must not write the rest
  // away.
  const A = 'http://127.0.0.1:3099'
  const B = 'http://127.0.0.1:4000'
  const C = 'http://127.0.0.1:5000'
  const good = { alg: 'Ed25519', publicKey: 'A-KEY', pinnedAt: '2026-09-01T00:00:00.000Z' }
  const seeded = () => {
    const storage = fakeStorage()
    storage.setItem(
      'whiteboard:daemon-identity-pins',
      JSON.stringify({
        [A]: good,
        [B]: { ...good, publicKey: 'B-KEY', addedByANewerBuild: true },
      }),
    )
    return storage
  }

  it('still answers the entries it can read', () => {
    expect(pinnedKey(A, seeded())).toBe('A-KEY')
  })

  it('answers unreadable for that entry, never "not pinned"', () => {
    expect(pinnedKey(B, seeded())).toBe('unreadable')
  })

  it('keeps every entry, the unreadable one too, when another daemon is pinned', () => {
    // Writing back only what parsed would turn B's pin into no pin at all —
    // and an unpinned daemon is renewed without verification.
    const storage = seeded()
    pinIdentity(C, { alg: 'Ed25519', publicKey: 'C-KEY' }, storage)
    expect(pinnedKey(A, storage)).toBe('A-KEY')
    expect(pinnedKey(B, storage)).toBe('unreadable')
    expect(pinnedKey(C, storage)).toBe('C-KEY')
  })

  it('challenges a daemon whose pin is unreadable as failed, without asking it', async () => {
    const fetch = vi.fn()
    const result = await challengeDaemonIdentity({
      daemonBaseUrl: B,
      fetch,
      hostedOrigin: 'https://app.example',
      storage: seeded(),
    })
    expect(result).toBe('failed')
    expect(fetch).not.toHaveBeenCalled()
  })
})
