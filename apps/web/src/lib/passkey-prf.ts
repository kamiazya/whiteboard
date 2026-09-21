/**
 * WebAuthn's `prf` extension, probed rather than assumed.
 *
 * ADR-0042 decision 6 and ADR-0039 decision 6 ship as ONE gesture: the
 * assertion that verifies the person before a workspace opens is the same
 * assertion that yields the material for the key that unwraps the local
 * copy. Two prompts for one intent is what this avoids.
 *
 * Support is broad on platform authenticators (ADR-0039's 2026-09-13
 * measurement) and NOT universal. An authenticator that does not implement
 * the extension answers a perfectly ordinary, successful assertion with
 * nothing attached — the person is verified, and only the key material is
 * missing. So every reader here degrades to null and the caller falls back
 * to today's behaviour (the key lives in memory for the tab's life). Never
 * a user-agent check: what a browser reports and what its authenticator
 * does are different questions.
 */

const textEncoder = new TextEncoder()

/** What `deriveWrappingKey` requires, and what a conforming prf returns. */
const PRF_OUTPUT_BYTES = 32

/**
 * The extension's `eval.first` input for a daemon.
 *
 * DERIVED from the daemon's URL rather than random, and that is the whole
 * reason this function exists: the authenticator maps (credential, input) to
 * a stable output, so a random input would hand every session a different
 * wrapping key and every blob already on disk would be unopenable. Stable
 * input, stable key, a copy that survives the tab closing.
 *
 * Per DAEMON rather than per workspace: one gesture yields one output, and
 * asking per workspace would be the second prompt this design exists to
 * avoid. A blob's workspace is bound in the AES-GCM additional data instead
 * (`daemon-client`'s `replica-key-wrap.ts`).
 *
 * SHA-256 rather than a fixed-width fill of the encoded text. The first
 * version filled 32 bytes by repeating the bytes of
 * `wb-replica-prf-v1:<url>`, and that prefix alone is longer than 32 bytes
 * for a `http://127.0.0.1:<port>` daemon — so two daemons differing only in
 * their port produced the SAME input, and every workspace on either would
 * have been wrapped under one key. Its own test caught it.
 */
export async function prfInputForDaemon(daemonBaseUrl: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(`wb-replica-prf-v1:${daemonBaseUrl}`) as BufferSource,
  )
  return new Uint8Array(digest)
}

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
