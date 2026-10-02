/**
 * WebAuthn's `prf` extension, probed rather than assumed.
 *
 * Support is broad on platform authenticators (ADR-0039's 2026-09-13
 * measurement) and NOT universal. An authenticator that does not implement
 * the extension answers a perfectly ordinary, successful assertion with
 * nothing attached — the person is verified, and only the key material is
 * missing. So the reader here degrades to null and the caller says so.
 * Never a user-agent check: what a browser reports and what its
 * authenticator does are different questions.
 */

import { PRF_OUTPUT_BYTES } from '@kamiazya/whiteboard-daemon-client/key-widths'

/**
 * The prf output an assertion carried, or null.
 *
 * Null covers every way the material can be absent — the extension ignored,
 * an empty results object, an output of the wrong width, a credential that
 * exposes no extension results at all. The caller treats all of them the
 * same way, so distinguishing them here would only invite a branch that
 * means nothing.
 */
export function prfOutputOf(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const results = credential.getClientExtensionResults?.() as
    | { prf?: { results?: { first?: unknown } } }
    | undefined
  const first = results?.prf?.results?.first
  if (!(first instanceof ArrayBuffer)) return null
  if (first.byteLength !== PRF_OUTPUT_BYTES) return null
  return new Uint8Array(first)
}
