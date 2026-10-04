/**
 * A database another process holds locked, recognised by the code it keeps
 * rather than by its class: the retry budget's error lives in a Node-only
 * store, and an unretried busy answer raised inside a transaction carries the
 * same code. libsql reports the primary code in `code` and any extended one
 * (`SQLITE_BUSY_*`) in `extendedCode`. The one definition: the daemon store's
 * retry, its workspace-record cache and server-core's 503 all ask it.
 */
export function isDatabaseBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, extendedCode } = err as { code?: unknown; extendedCode?: unknown }
  return [code, extendedCode].some((c) => typeof c === 'string' && c.startsWith('SQLITE_BUSY'))
}
