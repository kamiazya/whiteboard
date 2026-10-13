/**
 * What to call a thrown thing: an `Error`'s own message, else `fallback`.
 *
 * An `Error` with an empty message reads as the fallback too, since a blank
 * line in a toast or a log is worse than a generic one. Anything that is not
 * an `Error` — a string, `undefined`, a plain object that merely has a
 * `message` — also answers the fallback: the caller says what it would rather
 * show, and `String(err)` is the fallback to pass when the thrown value is
 * itself the best description available — or `describeThrown(err)`, which also
 * names what a thrown plain object carries.
 *
 * Lives in `model` only because it is the one package every runtime-sharing
 * layer (the daemon, the browser app, the shared tool layer) already depends
 * on; it has no document-model meaning. The check is `instanceof`, so an
 * `Error` built by another realm answers the fallback.
 */
export function messageOf(err: unknown, fallback = 'unknown error'): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback
}

/** Long enough for a `{ code, reason }` shape; short enough for one log line. */
const DESCRIBE_THROWN_MAX = 500

/**
 * What a thrown value says, when the value itself is the best description
 * available: an `Error`'s message (its name when the message is empty), a
 * primitive's string form, and a plain object's JSON. `String()` of an object
 * reads `[object Object]`, which names nothing — and libraries, polyfills and
 * structured-clone boundaries do throw plain `{ code, … }` objects. An object
 * JSON cannot write (a cycle, a BigInt, a bare function) answers its type.
 * The JSON is capped, since a thrown object can drag a whole payload with it.
 */
export function describeThrown(value: unknown): string {
  if (value instanceof Error) return messageOf(value, String(value))
  if (typeof value !== 'object' || value === null) return String(value)
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return typeof value
  }
  if (json === undefined) return typeof value
  return json.length > DESCRIBE_THROWN_MAX ? `${json.slice(0, DESCRIBE_THROWN_MAX)}…` : json
}
