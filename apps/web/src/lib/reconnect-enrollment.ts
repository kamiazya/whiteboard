import { enrollReconnectCredential, type FetchLike } from './reconnect-client.js'
import { save as saveLegacySecret } from './reconnect-credential-store.js'
import { exportPublicJwk } from './reconnect-crypto.js'
import {
  clearKeypair,
  getOrCreateKeypair,
  type ReconnectKeypairRecord,
} from './reconnect-keypair-store.js'

function defaultFetchImpl(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

// Injectable seams so unit tests can exercise the enrollment/fallback
// branching without a real IndexedDB or WebCrypto keypair (see
// test-layer-selection: persistence + signing belong in web-browser tests,
// not jsdom).
export interface ReconnectEnrollmentDeps {
  getOrCreateKeypair: (origin: string) => Promise<ReconnectKeypairRecord>
  exportPublicJwk: (
    publicKey: CryptoKey,
  ) => Promise<Parameters<typeof enrollReconnectCredential>[2]>
  clearKeypair: (origin: string, keyId: string) => Promise<void>
}

const defaultDeps: ReconnectEnrollmentDeps = { getOrCreateKeypair, exportPublicJwk, clearKeypair }

// Module-level single-flight (not per-component state) so a StrictMode
// double-render, or two components racing to enroll on the same page load,
// cannot fire two /api/reconnect-credential requests.
let inFlight: Promise<void> | null = null

// Test-only: clears single-flight state between tests.
export function resetReconnectEnrollmentForTests(): void {
  inFlight = null
}

/**
 * Enrolls `origin` for silent reconnect after a successful #wb= pairing.
 * Attempted for every authMode (including a tokenless daemon, where
 * `daemonToken` is null and the Authorization header is omitted entirely —
 * the daemon's auth middleware treats an absent token as authenticated).
 *
 * Crash-safe ordering: (1) generate a keypair and persist it 'pending' in
 * IndexedDB, (2) POST the public key to the daemon. This function stops
 * there — the keypair record only becomes 'confirmed' (and the legacy
 * secret, if any, only gets cleared) once useSilentReconnect.ts actually
 * completes a challenge-response login with it, proving the private key
 * works end-to-end rather than merely that the daemon accepted the public
 * half.
 *
 * Failure (network, rejection, or a browser too old for WebCrypto) is
 * non-fatal and does not throw: a later page load simply has no silent-
 * reconnect option and falls back to the existing DaemonDetectedBanner
 * one-click flow. A pre-migration daemon that responds with a legacy
 * plaintext secret instead of accepting the public key is handled by
 * persisting that secret for the legacy Bearer-secret fallback path AND
 * clearing the 'pending' keypair record just created — that daemon will
 * never confirm it, and leaving it in place would make useSilentReconnect
 * keep preferring the dead keypair over the legacy secret on every reload.
 */
export function enrollForReconnectOnce(
  origin: string,
  daemonToken: string | null,
  fetchImpl: FetchLike = defaultFetchImpl,
  deps: ReconnectEnrollmentDeps = defaultDeps,
): void {
  if (inFlight) return
  inFlight = (async () => {
    const keypair = await deps.getOrCreateKeypair(origin)
    const publicKeyJwk = await deps.exportPublicJwk(keypair.publicKey)
    const result = await enrollReconnectCredential(origin, daemonToken, publicKeyJwk, fetchImpl)
    if (result.status === 'legacy') {
      saveLegacySecret(origin, result.secret)
      // A pre-migration daemon never learns to confirm this keypair (no
      // challenge-response support) — leaving the 'pending' record in place
      // would make useSilentReconnect prefer it over the legacy secret just
      // saved above on every subsequent reload, permanently blocking the
      // fallback this branch exists to provide. Best-effort: if the clear
      // itself fails, the outer catch still keeps enrollment non-fatal.
      await deps.clearKeypair(origin, keypair.keyId).catch(() => {})
    }
  })()
    .catch(() => {
      // Non-fatal by contract; see doc comment above.
    })
    .finally(() => {
      // Single-flight guards only the PENDING window. Once settled, a later
      // pairing in the same SPA session (or a retry after a transient
      // failure) must be able to enroll again.
      inFlight = null
    })
}
