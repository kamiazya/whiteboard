import { describe, expect, it, vi } from 'vitest'
import type { PasskeyCredentials } from './passkey-attestation.js'
import { bindPasskeySession } from './passkey-session.js'

const DAEMON = 'http://127.0.0.1:3099'
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const RAW_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])

/** A storage already holding a registered passkey for DAEMON. */
function withRegisteredPasskey() {
  const storage = memoryStorage()
  storage.setItem(
    PASSKEYS_KEY,
    JSON.stringify({ [DAEMON]: { credentialId: b64u(RAW_ID), registeredAt: 'x' } }),
  )
  return storage
}

const CHALLENGE_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i)
const CHALLENGE_B64U = b64u(CHALLENGE_BYTES)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function assertionCredential(): Credential {
  return {
    id: b64u(RAW_ID),
    type: 'public-key',
    rawId: RAW_ID.buffer,
    response: {
      authenticatorData: Uint8Array.from({ length: 37 }, (_, i) => 37 - i).buffer,
      clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
      signature: Uint8Array.from([70, 71, 72]).buffer,
    },
  } as unknown as Credential
}

describe('bindPasskeySession', () => {
  it('answers no-passkey when this daemon has none registered', async () => {
    const fetchSpy = vi.fn()
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: fetchSpy,
      credentials: { create: async () => null, get: async () => null },
      storage: memoryStorage(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'no-passkey' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers no-passkey when credentials is undefined (unsupported)', async () => {
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(),
      credentials: undefined,
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'no-passkey' })
  })

  it('answers unreachable when the challenge fetch throws', async () => {
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async () => {
        throw new Error('network down')
      }),
      credentials: { create: async () => null, get: async () => assertionCredential() },
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('answers rejected on a non-2xx challenge response', async () => {
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async () => jsonResponse(401, { error: 'nope' })),
      credentials: { create: async () => null, get: async () => assertionCredential() },
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'rejected' })
  })

  it('answers rejected when the challenge body does not parse as the contract', async () => {
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async () => jsonResponse(200, { nonsense: true })),
      credentials: { create: async () => null, get: async () => assertionCredential() },
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'rejected' })
  })

  it('answers cancelled when the passkey prompt is dismissed', async () => {
    const cancel = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async (url) => {
        expect(String(url)).toBe('/api/pairing/session-assert/challenge')
        return jsonResponse(200, {
          challenge: CHALLENGE_B64U,
          expiresAt: '2026-01-01T00:00:00.000Z',
        })
      }),
      credentials: {
        create: async () => null,
        get: async () => Promise.reject(cancel),
      },
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('answers rejected on a non-2xx session-assert response', async () => {
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async (url) => {
        if (String(url).endsWith('/challenge')) {
          return jsonResponse(200, {
            challenge: CHALLENGE_B64U,
            expiresAt: '2026-01-01T00:00:00.000Z',
          })
        }
        return jsonResponse(403, { error: 'requires_person_session' })
      }),
      credentials: { create: async () => null, get: async () => assertionCredential() },
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'rejected' })
  })

  it('answers unreachable when the assert fetch throws', async () => {
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async (url) => {
        if (String(url).endsWith('/challenge')) {
          return jsonResponse(200, {
            challenge: CHALLENGE_B64U,
            expiresAt: '2026-01-01T00:00:00.000Z',
          })
        }
        throw new Error('network down mid-assert')
      }),
      credentials: { create: async () => null, get: async () => assertionCredential() },
      storage: withRegisteredPasskey(),
    })
    expect(outcome).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('binds the session: posts the decoded challenge to credentials.get and the attestation minus kind to session-assert', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let requestedChallenge: Uint8Array | undefined
    const credentials: PasskeyCredentials = {
      create: async () => null,
      get: async (options) => {
        requestedChallenge = new Uint8Array(options.publicKey?.challenge as ArrayBuffer)
        return assertionCredential()
      },
    }
    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init })
        if (String(url).endsWith('/challenge')) {
          return jsonResponse(200, {
            challenge: CHALLENGE_B64U,
            expiresAt: '2026-01-01T00:00:00.000Z',
          })
        }
        return jsonResponse(200, {
          credentialId: b64u(RAW_ID),
          profileId: null,
          boundUntil: '2026-01-01T01:00:00.000Z',
        })
      }),
      credentials,
      storage: withRegisteredPasskey(),
    })

    expect(outcome).toEqual({ ok: true })
    expect(requestedChallenge).toEqual(CHALLENGE_BYTES)
    expect(calls[0]?.url).toBe('/api/pairing/session-assert/challenge')
    expect(calls[1]?.url).toBe('/api/pairing/session-assert')
    const body = JSON.parse(String(calls[1]?.init?.body))
    expect(body).toEqual({
      credentialId: b64u(RAW_ID),
      authenticatorData: b64u(Uint8Array.from({ length: 37 }, (_, i) => 37 - i)),
      clientDataJSON: b64u(new TextEncoder().encode('{"type":"webauthn.get"}')),
      signature: b64u(Uint8Array.from([70, 71, 72])),
    })
    expect(body).not.toHaveProperty('kind')
  })
})

describe('bindPasskeySession: the one gesture (ADR-0042 d6)', () => {
  /** A fetch that answers the two session-assert calls in order. */
  function bindingFetch(): typeof globalThis.fetch {
    return vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/challenge')
        ? jsonResponse(200, {
            challenge: CHALLENGE_B64U,
            expiresAt: '2026-01-01T00:00:00.000Z',
          })
        : jsonResponse(200, {
            credentialId: b64u(RAW_ID),
            profileId: null,
            boundUntil: '2026-01-01T01:00:00.000Z',
          }),
    ) as unknown as typeof globalThis.fetch
  }

  function credentialsYielding(prf?: Uint8Array): {
    credentials: PasskeyCredentials
    asked: () => CredentialRequestOptions[]
  } {
    const calls: CredentialRequestOptions[] = []
    return {
      credentials: {
        create: async () => null,
        get: async (options) => {
          calls.push(options as CredentialRequestOptions)
          const credential = assertionCredential() as unknown as Record<string, unknown>
          credential.getClientExtensionResults = () =>
            prf === undefined ? {} : { prf: { results: { first: prf.buffer } } }
          return credential as unknown as Credential
        },
      },
      asked: () => calls,
    }
  }

  it('carries a prf input on the assertion it already performs, and answers with its output', async () => {
    const first = new Uint8Array(32).fill(5)
    const { credentials, asked } = credentialsYielding(first)

    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: bindingFetch(),
      credentials,
      storage: withRegisteredPasskey(),
    })

    // ONE prompt does both jobs: it binds the session to the person AND
    // yields the material that wraps this replica's key for a cold start.
    expect(asked()).toHaveLength(1)
    expect(asked()[0]?.publicKey?.extensions?.prf).toBeDefined()
    expect(outcome).toEqual({ ok: true, prfOutput: first })
  })

  it('still binds the session when the authenticator produced no key material', async () => {
    const { credentials } = credentialsYielding(undefined)

    const outcome = await bindPasskeySession({
      daemonBaseUrl: DAEMON,
      fetch: bindingFetch(),
      credentials,
      storage: withRegisteredPasskey(),
    })

    // prf support is broad and not universal. Losing the cold start is the
    // whole cost; the session is bound either way.
    expect(outcome).toEqual({ ok: true })
  })
})
