/**
 * Asking the authenticator for a `prf` output on the assertion this app
 * ALREADY performs (ADR-0042 d6 + ADR-0039 d6, one gesture).
 *
 * Every case here is about the PROBE rather than the crypto: what the code
 * must never do is decide from a user-agent string or assume support,
 * because an authenticator that ignores the extension answers a perfectly
 * normal assertion with nothing attached — and a caller that assumed would
 * derive a wrapping key from undefined.
 */

import { describe, expect, it } from 'vitest'
import { prfInputForDaemon, prfOutputOf } from './passkey-prf.js'

function credentialWith(results: unknown): PublicKeyCredential {
  return {
    getClientExtensionResults: () => results as AuthenticationExtensionsClientOutputs,
  } as PublicKeyCredential
}

describe('prfOutputOf', () => {
  it('answers the bytes the authenticator returned', () => {
    const first = new Uint8Array(32).fill(3)

    // A real authenticator hands back an ArrayBuffer, not a view.
    expect(prfOutputOf(credentialWith({ prf: { results: { first: first.buffer } } }))).toEqual(
      first,
    )
  })

  it('answers null when the authenticator ignored the extension', () => {
    // The shape a non-supporting authenticator produces: a successful
    // assertion with no `prf` in its extension results at all. The person
    // was still verified; only the key material is absent.
    expect(prfOutputOf(credentialWith({}))).toBeNull()
    expect(prfOutputOf(credentialWith({ prf: {} }))).toBeNull()
    expect(prfOutputOf(credentialWith({ prf: { results: {} } }))).toBeNull()
  })

  it('answers null for an output that is not the length a wrapping key needs', () => {
    // Refused HERE rather than at `deriveWrappingKey`, which throws: a short
    // output is an authenticator quirk, not a programming error, and it must
    // degrade to "no cold start" rather than to an exception.
    expect(
      prfOutputOf(credentialWith({ prf: { results: { first: new Uint8Array(16).buffer } } })),
    ).toBeNull()
  })

  it('answers null rather than throwing when the credential exposes no extension results', () => {
    expect(prfOutputOf({} as PublicKeyCredential)).toBeNull()
  })
})

describe('prfInputForDaemon', () => {
  it('is stable for one daemon and differs between daemons', async () => {
    const a = await prfInputForDaemon('http://127.0.0.1:3099')

    // Stable, because a random input would hand every session a different
    // wrapping key and every blob already on disk would be unopenable.
    expect(await prfInputForDaemon('http://127.0.0.1:3099')).toEqual(a)
    // Two daemons differing ONLY in their port: the first version filled 32
    // bytes by repeating the encoded text, whose prefix is already longer
    // than 32 bytes, so both produced the same input.
    expect(await prfInputForDaemon('http://127.0.0.1:4000')).not.toEqual(a)
  })

  it('is 32 bytes, which is what the extension takes', async () => {
    expect(await prfInputForDaemon('http://127.0.0.1:3099')).toHaveLength(32)
  })
})
