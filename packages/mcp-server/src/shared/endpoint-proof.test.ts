import { describe, expect, it } from 'vitest'
import {
  endpointProof,
  endpointProofNonceSchema,
  isEndpointProof,
  newEndpointProofNonce,
} from './endpoint-proof.js'

describe('endpoint proof', () => {
  it('mints a nonce the route accepts, fresh on every call', () => {
    const first = newEndpointProofNonce()
    expect(endpointProofNonceSchema.safeParse(first).success).toBe(true)
    expect(newEndpointProofNonce()).not.toBe(first)
  })

  // A proof seen once — say, while the daemon was alive — must not answer a
  // later challenge, or whoever recorded it could replay it from a pipe they
  // took over.
  it('binds the proof to its nonce, so an earlier answer cannot be replayed', async () => {
    const seen = newEndpointProofNonce()
    const proof = await endpointProof('token', seen)
    await expect(isEndpointProof('token', seen, proof)).resolves.toBe(true)
    await expect(isEndpointProof('token', newEndpointProofNonce(), proof)).resolves.toBe(false)
  })

  it('refuses a proof that is not base64url, or that carries the token itself', async () => {
    const nonce = newEndpointProofNonce()
    for (const proof of ['', 'not base64!', 'token']) {
      await expect(isEndpointProof('token', nonce, proof)).resolves.toBe(false)
    }
  })
})
