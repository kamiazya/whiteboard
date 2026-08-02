// The reconnect-credential-store module that owned this constant is
// deleted along with unattended reconnect (see the module doc comment
// below); the literal is inlined here since this is now the sole reader.
const LEGACY_RECONNECT_SECRET_STORAGE_KEY = 'whiteboard.reconnect-secret.v1'

/**
 * One-shot cleanup for a credential this app no longer writes or reads:
 * the plaintext reconnect secret a pre-removal build persisted in
 * localStorage under `STORAGE_KEY`. Unattended reconnect is gone (see
 * `docs/explanation/security-model.md`), so a value surviving here is pure
 * liability — a same-origin script (including a later process that
 * squats this port) could read it and mint a daemon session with no
 * further interaction.
 *
 * Deliberately NOT gated on the IndexedDB open (browser-idb.ts's own
 * schema-version cleanup): a user who never triggers that open (e.g. a
 * tab that never mounts the browser-local store) would otherwise keep a
 * live plaintext secret indefinitely. Called unconditionally at boot
 * instead.
 *
 * Total: never throws, even when localStorage itself throws (private
 * mode, quota, disabled storage) — a boot-time cleanup must never be the
 * reason the app fails to start.
 */
export function purgeLegacyReconnectCredentials(): void {
  try {
    localStorage.removeItem(LEGACY_RECONNECT_SECRET_STORAGE_KEY)
  } catch {
    // Contract: never throws.
  }
}
