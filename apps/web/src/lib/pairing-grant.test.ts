import { describe, expect, it, vi } from 'vitest'
import {
  beginPairingGrant,
  consumeGrantFragment,
  createPkcePair,
  parseGrantFragment,
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
    expect(parseGrantFragment('#wb-grant=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
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
    expect(JSON.parse(String(init.body))).toEqual({
      grantType: 'code',
      code: 'the-code',
      codeVerifier: 'verifier',
    })
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
