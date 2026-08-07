import { describe, expect, it, vi } from 'vitest'
import {
  beginPairingGrant,
  consumeGrantFragment,
  createPkcePair,
  parseGrantFragment,
  renewPairingToken,
} from './pairing-grant.js'

const DAEMON = 'http://127.0.0.1:3099'
const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'

describe('PKCE pair', () => {
  it('produces a verifier and its S256 challenge (base64url, no padding)', async () => {
    const { codeVerifier, codeChallenge } = await createPkcePair()
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
    const again = await createPkcePair()
    expect(again.codeVerifier).not.toBe(codeVerifier)
  })
})

describe('grant fragment', () => {
  it('parses #wb-grant=<code>&state=<state>', () => {
    expect(parseGrantFragment('#wb-grant=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
      identity: null,
    })
    expect(parseGrantFragment('#wb-grant=abc&state=xyz&identity=pk')).toEqual({
      code: 'abc',
      state: 'xyz',
      identity: 'pk',
    })
  })

  it('returns null for an absent or incomplete fragment', () => {
    expect(parseGrantFragment('')).toBeNull()
    expect(parseGrantFragment('#wb=other')).toBeNull()
    expect(parseGrantFragment('#wb-grant=abc')).toBeNull()
  })
})

describe('beginPairingGrant', () => {
  it('stashes verifier+state and navigates to the daemon /pair page', async () => {
    const storage = new Map<string, string>()
    const assigned: string[] = []
    await beginPairingGrant({
      daemonBaseUrl: DAEMON,
      hostedOrigin: HOSTED,
      sessionStorage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => void storage.set(k, v),
        removeItem: (k) => void storage.delete(k),
      },
      navigate: (url) => assigned.push(url),
    })

    expect(assigned).toHaveLength(1)
    const url = new URL(assigned[0] as string)
    expect(url.origin).toBe(DAEMON)
    expect(url.pathname).toBe('/pair')
    expect(url.searchParams.get('origin')).toBe(HOSTED)
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
    const state = url.searchParams.get('state')
    expect(state).toBeTruthy()

    const stashed = JSON.parse(storage.get('whiteboard:pairing-transaction') as string)
    expect(stashed.state).toBe(state)
    expect(stashed.daemonBaseUrl).toBe(DAEMON)
    expect(typeof stashed.codeVerifier).toBe('string')
  })
})

describe('renewPairingToken', () => {
  it('mints a token via grantType origin against the stored daemon', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ token: 'renewed', expiresAt: '2099-01-01T00:00:00.000Z', origin: HOSTED }),
    )
    const result = await renewPairingToken({
      daemonBaseUrl: `${DAEMON}/`,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(result).toEqual({ status: 'paired', daemonBaseUrl: DAEMON, token: 'renewed' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DAEMON}/api/pairing/token`)
    expect(JSON.parse(String(init.body))).toEqual({ grantType: 'origin' })
  })

  it('reports none on a 403 (grant revoked / daemon restarted unpaired)', async () => {
    const fetchFn = vi.fn(async () => new Response('no grant', { status: 403 }))
    const result = await renewPairingToken({
      daemonBaseUrl: DAEMON,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(result).toEqual({ status: 'none' })
  })

  it('reports none when the daemon is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await renewPairingToken({
      daemonBaseUrl: DAEMON,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(result).toEqual({ status: 'none' })
  })
})

describe('consumeGrantFragment', () => {
  function makeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    return {
      map,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    }
  }

  it('exchanges the code for a token and clears the transaction', async () => {
    const { map, storage } = makeStorage({
      'whiteboard:pairing-transaction': JSON.stringify({
        state: 'st-1',
        codeVerifier: 'verifier',
        daemonBaseUrl: DAEMON,
      }),
    })
    const fetchFn = vi.fn(async () =>
      Response.json({ token: 'tok', expiresAt: '2099-01-01T00:00:00.000Z', origin: HOSTED }),
    )

    const result = await consumeGrantFragment({
      hash: '#wb-grant=the-code&state=st-1',
      sessionStorage: storage,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })

    expect(result).toEqual({ status: 'paired', daemonBaseUrl: DAEMON, token: 'tok' })
    expect(map.has('whiteboard:pairing-transaction')).toBe(false)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DAEMON}/api/pairing/token`)
    expect(JSON.parse(String(init.body))).toMatchObject({
      grantType: 'code',
      code: 'the-code',
      codeVerifier: 'verifier',
    })
    // The exchange always challenges with a fresh nonce.
    expect(JSON.parse(String(init.body)).nonce).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  })

  it('rejects a state mismatch without exchanging anything', async () => {
    const { storage } = makeStorage({
      'whiteboard:pairing-transaction': JSON.stringify({
        state: 'expected',
        codeVerifier: 'v',
        daemonBaseUrl: DAEMON,
      }),
    })
    const fetchFn = vi.fn()
    const result = await consumeGrantFragment({
      hash: '#wb-grant=code&state=attacker',
      sessionStorage: storage,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(result.status).toBe('error')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns none when no grant fragment is present', async () => {
    const { storage } = makeStorage()
    const result = await consumeGrantFragment({
      hash: '#something-else',
      sessionStorage: storage,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    })
    expect(result).toEqual({ status: 'none' })
  })

  it('surfaces a rejected exchange as an error', async () => {
    const { storage } = makeStorage({
      'whiteboard:pairing-transaction': JSON.stringify({
        state: 'st',
        codeVerifier: 'v',
        daemonBaseUrl: DAEMON,
      }),
    })
    const fetchFn = vi.fn(async () => new Response('nope', { status: 403 }))
    const result = await consumeGrantFragment({
      hash: '#wb-grant=code&state=st',
      sessionStorage: storage,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(result.status).toBe('error')
  })
})

describe('mutual authentication (identity pinning)', () => {
  function makeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    return {
      map,
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    }
  }

  function bytesToBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
  }

  async function makeDaemonSigner() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const publicKey = jwk.x as string
    const sign = async (parts: readonly string[]) =>
      bytesToBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'Ed25519' },
            pair.privateKey,
            new TextEncoder().encode(JSON.stringify(parts)),
          ),
        ),
      )
    return { publicKey, sign }
  }

  async function sha256b64u(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return bytesToBase64Url(new Uint8Array(digest))
  }

  // A fetch stub that behaves like the real daemon: signs whatever nonce
  // the request carries, with the given signer.
  function daemonFetch(signer: Awaited<ReturnType<typeof makeDaemonSigner>>, token = 'tok') {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { nonce?: string }
      const expiresAt = '2099-01-01T00:00:00.000Z'
      const identity =
        body.nonce !== undefined
          ? {
              alg: 'Ed25519',
              publicKey: signer.publicKey,
              signature: await signer.sign([
                'wb-token-v1',
                body.nonce,
                HOSTED,
                await sha256b64u(token),
                expiresAt,
              ]),
            }
          : undefined
      return Response.json({ token, expiresAt, origin: HOSTED, identity })
    })
  }

  it('exchange with a fragment identity verifies the signature and pins the key', async () => {
    const signer = await makeDaemonSigner()
    const { storage } = makeStorage({
      'whiteboard:pairing-transaction': JSON.stringify({
        state: 'st-1',
        codeVerifier: 'verifier',
        daemonBaseUrl: DAEMON,
      }),
    })
    const pins = makeStorage()

    const result = await consumeGrantFragment({
      hash: `#wb-grant=code&state=st-1&identity=${encodeURIComponent(signer.publicKey)}`,
      sessionStorage: storage,
      fetch: daemonFetch(signer) as unknown as typeof globalThis.fetch,
      hostedOrigin: HOSTED,
      pinStorage: pins.storage,
    })

    expect(result.status).toBe('paired')
    const stored = JSON.parse(pins.map.get('whiteboard:daemon-identity-pins') ?? '{}')
    expect(stored[DAEMON]?.publicKey).toBe(signer.publicKey)
  })

  it("exchange refuses a response signed by a DIFFERENT key than the approved fragment's", async () => {
    const approved = await makeDaemonSigner()
    const squatter = await makeDaemonSigner()
    const { storage } = makeStorage({
      'whiteboard:pairing-transaction': JSON.stringify({
        state: 'st-1',
        codeVerifier: 'verifier',
        daemonBaseUrl: DAEMON,
      }),
    })
    const pins = makeStorage()

    const result = await consumeGrantFragment({
      hash: `#wb-grant=code&state=st-1&identity=${encodeURIComponent(approved.publicKey)}`,
      sessionStorage: storage,
      fetch: daemonFetch(squatter) as unknown as typeof globalThis.fetch,
      hostedOrigin: HOSTED,
      pinStorage: pins.storage,
    })

    expect(result).toEqual({ status: 'error', detail: 'daemon identity verification failed' })
    expect(pins.map.has('whiteboard:daemon-identity-pins')).toBe(false)
  })

  it('renewal against a pinned daemon verifies and stays paired', async () => {
    const signer = await makeDaemonSigner()
    const pins = makeStorage({
      'whiteboard:daemon-identity-pins': JSON.stringify({
        [DAEMON]: { alg: 'Ed25519', publicKey: signer.publicKey, pinnedAt: 'then' },
      }),
    })

    const result = await renewPairingToken({
      daemonBaseUrl: DAEMON,
      fetch: daemonFetch(signer) as unknown as typeof globalThis.fetch,
      hostedOrigin: HOSTED,
      pinStorage: pins.storage,
    })
    expect(result.status).toBe('paired')
  })

  it('renewal fails CLOSED with identity-mismatch when a pinned daemon answers with another key', async () => {
    const pinnedKey = await makeDaemonSigner()
    const squatter = await makeDaemonSigner()
    const pins = makeStorage({
      'whiteboard:daemon-identity-pins': JSON.stringify({
        [DAEMON]: { alg: 'Ed25519', publicKey: pinnedKey.publicKey, pinnedAt: 'then' },
      }),
    })

    const result = await renewPairingToken({
      daemonBaseUrl: DAEMON,
      fetch: daemonFetch(squatter) as unknown as typeof globalThis.fetch,
      hostedOrigin: HOSTED,
      pinStorage: pins.storage,
    })
    expect(result).toEqual({ status: 'identity-mismatch', daemonBaseUrl: DAEMON })
    // The pin survives (evidence for the warning UI), per the approved design.
    expect(pins.map.get('whiteboard:daemon-identity-pins')).toContain(pinnedKey.publicKey)
  })

  it('renewal against an UNPINNED daemon sends no nonce and stays on the legacy path', async () => {
    const signer = await makeDaemonSigner()
    const pins = makeStorage()
    const fetchFn = daemonFetch(signer)

    const result = await renewPairingToken({
      daemonBaseUrl: DAEMON,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      hostedOrigin: HOSTED,
      pinStorage: pins.storage,
    })
    expect(result.status).toBe('paired')
    const body = JSON.parse(
      String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    )
    expect(body.nonce).toBeUndefined()
  })
})
