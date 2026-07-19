/**
 * Real IndexedDB + real WebCrypto round trip: jsdom has neither, so this
 * (persistence, and — since a non-extractable CryptoKey can only be proven
 * to work by actually using it — the signing half of the flow) belongs in
 * web-browser, not a jsdom unit test.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DB_VERSION, openWhiteboardDb } from './browser-idb.js'
import { exportPublicJwk, signReconnectNonce } from './reconnect-crypto.js'
import {
  clearKeypair,
  getOrCreateKeypair,
  loadKeypair,
  markKeypairConfirmed,
} from './reconnect-keypair-store.js'

const ORIGIN_A = 'http://localhost:3099'
const ORIGIN_B = 'http://localhost:4000'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

describe('reconnect keypair persistence (real IndexedDB + WebCrypto)', () => {
  afterEach(clearDb)

  it('current DB_VERSION is 5 or higher (guards against reverting the bump alone)', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(5)
  })

  it('generates a keypair, persists it as pending, and round-trips through IndexedDB', async () => {
    const created = await getOrCreateKeypair(ORIGIN_A)
    expect(created.status).toBe('pending')
    expect(created.publicKey).toBeInstanceOf(CryptoKey)
    expect(created.privateKey).toBeInstanceOf(CryptoKey)

    const reloaded = await loadKeypair(ORIGIN_A)
    expect(reloaded?.status).toBe('pending')
    expect(reloaded?.publicKey).toBeInstanceOf(CryptoKey)
  })

  it('getOrCreateKeypair is idempotent: a second call reuses the stored key', async () => {
    const first = await getOrCreateKeypair(ORIGIN_A)
    const second = await getOrCreateKeypair(ORIGIN_A)
    const firstJwk = await exportPublicJwk(first.publicKey)
    const secondJwk = await exportPublicJwk(second.publicKey)
    expect(secondJwk).toEqual(firstJwk)
  })

  it('keeps distinct keypairs per origin', async () => {
    const a = await getOrCreateKeypair(ORIGIN_A)
    const b = await getOrCreateKeypair(ORIGIN_B)
    const aJwk = await exportPublicJwk(a.publicKey)
    const bJwk = await exportPublicJwk(b.publicKey)
    expect(aJwk).not.toEqual(bJwk)
  })

  it('markKeypairConfirmed flips status without changing the key material', async () => {
    const created = await getOrCreateKeypair(ORIGIN_A)
    await markKeypairConfirmed(ORIGIN_A)
    const reloaded = await loadKeypair(ORIGIN_A)
    expect(reloaded?.status).toBe('confirmed')
    const originalJwk = await exportPublicJwk(created.publicKey)
    const reloadedJwk = await exportPublicJwk(reloaded!.publicKey)
    expect(reloadedJwk).toEqual(originalJwk)
  })

  it('clearKeypair removes the record entirely', async () => {
    await getOrCreateKeypair(ORIGIN_A)
    await clearKeypair(ORIGIN_A)
    expect(await loadKeypair(ORIGIN_A)).toBeNull()
  })

  it('exports a canonical 4-field JWK (no ext/key_ops/alg) and the daemon can verify a signature made with the stored private key', async () => {
    const { publicKey, privateKey } = await getOrCreateKeypair(ORIGIN_A)
    const jwk = await exportPublicJwk(publicKey)
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y'])

    const signature = await signReconnectNonce(privateKey, 'nonce-value')

    // Mirrors the daemon's verifyP1363Signature (web-origin-trust-store.ts):
    // import the exported JWK for verify-only use and check the P1363
    // signature against the exact nonce string that was signed.
    const verifyKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, ext: true, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const signatureBytes = Uint8Array.from(
      atob(signature.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    )
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      signatureBytes,
      new TextEncoder().encode('nonce-value'),
    )
    expect(verified).toBe(true)

    // A signature over a different message must NOT verify.
    const wrongVerified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      signatureBytes,
      new TextEncoder().encode('different-nonce'),
    )
    expect(wrongVerified).toBe(false)
  })

  it('recovers from a corrupt stored row instead of permanently bricking enrollment for that origin', async () => {
    // Seed a schema-invalid row directly (e.g. a stale/half-written record
    // from a previous app version) — loadKeypair maps this to null but must
    // also clear it, or the later add() in getOrCreateKeypair permanently
    // fails with ConstraintError since the corrupt row still owns the key.
    const db = await openWhiteboardDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('reconnectKeypairs', 'readwrite')
      tx.objectStore('reconnectKeypairs').put({ origin: ORIGIN_A, v: 1, status: 'bogus' })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    })

    expect(await loadKeypair(ORIGIN_A)).toBeNull()

    const recovered = await getOrCreateKeypair(ORIGIN_A)
    expect(recovered.status).toBe('pending')
    expect(recovered.publicKey).toBeInstanceOf(CryptoKey)

    const reloaded = await loadKeypair(ORIGIN_A)
    expect(reloaded?.publicKey).toBeInstanceOf(CryptoKey)
  })

  it('two concurrent getOrCreateKeypair calls for the same origin converge on one stored key', async () => {
    const [first, second] = await Promise.all([
      getOrCreateKeypair(ORIGIN_A),
      getOrCreateKeypair(ORIGIN_A),
    ])
    const firstJwk = await exportPublicJwk(first.publicKey)
    const secondJwk = await exportPublicJwk(second.publicKey)
    expect(secondJwk).toEqual(firstJwk)

    const db = await openWhiteboardDb()
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction('reconnectKeypairs', 'readonly')
      const req = tx.objectStore('reconnectKeypairs').count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
    expect(count).toBe(1)
  })
})
