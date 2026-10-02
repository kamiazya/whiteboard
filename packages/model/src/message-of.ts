/**
 * What to call a thrown thing: an `Error`'s own message, else `fallback`.
 *
 * An `Error` with an empty message reads as the fallback too, since a blank
 * line in a toast or a log is worse than a generic one. Anything that is not
 * an `Error` — a string, `undefined`, a plain object that merely has a
 * `message` — also answers the fallback: the caller says what it would rather
 * show, and `String(err)` is the fallback to pass when the thrown value is
 * itself the best description available.
 *
 * Lives in `model` only because it is the one package every runtime-sharing
 * layer (the daemon, the browser app, the shared tool layer) already depends
 * on; it has no document-model meaning. The check is `instanceof`, so an
 * `Error` built by another realm answers the fallback.
 */
export function messageOf(err: unknown, fallback = 'unknown error'): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback
}
