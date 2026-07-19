/**
 * Real WebCrypto + IndexedDB round trip for the legacy-redemption ->
 * best-effort keypair enrollment path: jsdom (useSilentReconnect.test.ts)
 * mocks `enrollForReconnectOnce` entirely, so it never exercises real key
 * generation, `IndexedDB` persistence, or public-JWK export — only that the
 * function was called. This test wires the hook with its REAL default deps
 * (no DI overrides) so a break anywhere across that boundary — key
 * generation, storage schema, or JWK export shape — fails here instead of
 * only in production.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { clear as clearSecretStore, save } from '../lib/reconnect-credential-store.js'
import { resetReconnectEnrollmentForTests } from '../lib/reconnect-enrollment.js'
import { loadKeypair } from '../lib/reconnect-keypair-store.js'
import { resetSilentReconnectForTests, useSilentReconnect } from './useSilentReconnect.js'

const ORIGIN = 'http://localhost:3099'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(async () => {
  clearSecretStore()
  resetSilentReconnectForTests()
  resetReconnectEnrollmentForTests()
  await clearDb()
})

describe('useSilentReconnect (real WebCrypto + IndexedDB enrollment)', () => {
  it('a successful legacy redemption generates a real keypair and persists it pending in IndexedDB', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = (async (url: string | URL) => {
      if (String(url).endsWith('/api/reconnect-credential')) {
        return jsonResponse({ credentialKind: 'publicKey', expiresInDays: 30 })
      }
      return jsonResponse({ token: 'daemon-token' })
    }) as typeof fetch

    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )

    await waitFor(() => expect(result.current.status).toBe('connected'))

    // Enrollment is fire-and-forget from the hook's perspective, so wait for
    // it to actually land in IndexedDB rather than asserting immediately.
    await waitFor(async () => {
      const record = await loadKeypair(ORIGIN)
      expect(record).not.toBeNull()
      expect(record?.status).toBe('pending')
      expect(record?.publicKey).toBeInstanceOf(CryptoKey)
      expect(record?.privateKey).toBeInstanceOf(CryptoKey)
    })
  })

  it('a pre-migration daemon rejecting enrollment (legacy credential response) clears any pending keypair', async () => {
    save(ORIGIN, 'secret-1')
    const fetchMock = (async (url: string | URL) => {
      if (String(url).endsWith('/api/reconnect-credential')) {
        return jsonResponse({ reconnectSecret: 'secret-2', expiresInDays: 30 })
      }
      return jsonResponse({ token: 'daemon-token' })
    }) as typeof fetch

    const { result } = renderHook(() =>
      useSilentReconnect({ enabled: true, origin: ORIGIN, fetchImpl: fetchMock }),
    )

    await waitFor(() => expect(result.current.status).toBe('connected'))

    await waitFor(async () => {
      // The daemon never confirms this keypair, so enrollment must not leave
      // a pending record behind — see reconnect-enrollment.ts's doc comment.
      expect(await loadKeypair(ORIGIN)).toBeNull()
    })
  })
})
