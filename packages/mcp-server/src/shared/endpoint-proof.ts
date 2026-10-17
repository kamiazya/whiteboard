// A daemon's proof that it holds the token its daemon.json records, given
// without sending that token anywhere: an HMAC of a caller's nonce, keyed by
// the token.
//
// A reader that cannot tell whether a record's pid is still the daemon that
// wrote it (no /proc: Windows) has only the socket left to ask, and a named
// pipe a dead daemon released can be re-created by another OS user. Sending
// the token to whatever serves that name hands it over, so the server proves
// itself first. The token is the right key because it is exactly the secret
// being protected: a server that can answer already knows it.
//
// The label keeps the answer from being worth anything outside this exchange,
// so the route that computes it for any caller is no oracle for some other
// use of the token. The daemon's ed25519 identity key is deliberately NOT
// used: it is reserved for checkpoint signatures, and a route signing caller
// chosen bytes with it would be a signing oracle for that key.
//
// WebCrypto rather than `node:crypto`, so the runtime route that answers it
// stays as portable as it was.

import { base64UrlToBytes, bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

const PROOF_LABEL = 'whiteboard-daemon-endpoint-proof/v1\n'

export const ENDPOINT_PROOF_PATH = '/api/runtime/proof'

/** 32 random bytes, base64url without padding. */
export const endpointProofNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** An HMAC-SHA256, base64url without padding. */
export const endpointProofResponseSchema = z.object({ proof: z.string() })

function hmacKey(token: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

const proofInput = (nonce: string) => new TextEncoder().encode(`${PROOF_LABEL}${nonce}`)

export function newEndpointProofNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function endpointProof(token: string, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(token, 'sign'),
    proofInput(nonce),
  )
  return bytesToBase64Url(new Uint8Array(signature))
}

/** Whether `proof` is this token's answer to `nonce`; WebCrypto's verify compares in constant time. */
export async function isEndpointProof(
  token: string,
  nonce: string,
  proof: string,
): Promise<boolean> {
  const signature = base64UrlToBytes(proof)
  if (signature === null) return false
  return crypto.subtle.verify('HMAC', await hmacKey(token, 'verify'), signature, proofInput(nonce))
}

export function endpointProofUrl(nonce: string): string {
  return `${ENDPOINT_PROOF_PATH}?nonce=${nonce}`
}
