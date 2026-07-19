import type { EcP256PublicJwk } from '@kamiazya/whiteboard-mcp/api-contracts'

/**
 * WebCrypto primitives for the silent-reconnect keypair flow. Deliberately
 * has no IndexedDB dependency (see reconnect-keypair-store.ts for
 * persistence) so the pure crypto operations stay independently testable.
 */

// extractable:false so the private key material never leaves the browser's
// key store even via a bug that tries to export it — only the public half is
// ever exported (exportPublicJwk below).
export async function generateReconnectKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])
}

/**
 * Exports `publicKey` as the canonical 4-field JWK projection the daemon's
 * ecP256PublicJwkSchema expects — crypto.subtle.exportKey('jwk', ...) also
 * emits `ext`/`key_ops`/`alg`, none of which are part of the wire contract,
 * so they are dropped here rather than relying on the schema's `.strict()`
 * to reject them.
 */
export async function exportPublicJwk(publicKey: CryptoKey): Promise<EcP256PublicJwk> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey)
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('exportPublicJwk: unexpected JWK shape for an ECDSA P-256 public key')
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

/**
 * Signs `nonce` with `privateKey`, returning the raw P1363 (r||s) signature
 * as base64url — matching what the daemon's node:crypto webcrypto.subtle.verify
 * expects (see web-origin-trust-store.ts's verifyP1363Signature doc comment).
 * crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, ...) already produces
 * P1363, not DER, so no reformatting is needed beyond base64url-encoding.
 */
export async function signReconnectNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(nonce),
  )
  return arrayBufferToBase64Url(signature)
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
