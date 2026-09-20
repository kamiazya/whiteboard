// The one generator of ids for the elements a person draws: nodes, edges,
// lines and comment threads. Pure, so it lives beside the other spatial
// mechanics rather than inside the gesture reducer that used to hold it.

/**
 * A fresh element id.
 *
 * `crypto.randomUUID` is SECURE-CONTEXT ONLY, and this app is reached over
 * plain http on a LAN by design — Local Network Access is a feature here,
 * not an accident — so the fallback is a path real users take rather than a
 * theoretical one.
 *
 * `crypto.getRandomValues` carries no such restriction, which is why it is
 * the fallback rather than `Math.random`. Sixteen bytes as hex, so the id
 * is the same shape of opaque string a UUID is; `nodeIdSchema` asks only
 * for a non-empty string, so neither form is privileged by the model.
 *
 * `Math.random` survives as the last resort for a runtime with no `crypto`
 * at all. Nothing this app supports is in that state, and it is one line
 * rather than a throw because an id generator that can fail turns a drawn
 * box into an error.
 */
export const defaultCreateId = (): string => {
  if (typeof crypto === 'undefined') return String(Math.random())
  // Read through a view that admits `randomUUID` may be ABSENT. The DOM lib
  // declares it required on `Crypto`, so `'randomUUID' in crypto` narrows
  // the else branch to `never` — the type says something about the platform
  // that is not true in an insecure context, which is the whole case this
  // function exists to handle.
  const api = crypto as {
    randomUUID?: () => string
    getRandomValues?: (array: Uint8Array) => Uint8Array
  }
  if (typeof api.randomUUID === 'function') return api.randomUUID()
  if (typeof api.getRandomValues === 'function') {
    const bytes = api.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return String(Math.random())
}
