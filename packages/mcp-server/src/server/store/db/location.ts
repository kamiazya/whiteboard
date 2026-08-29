import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DB_FILENAME = 'whiteboard.db'
export const DB_URL_ENV = 'WHITEBOARD_DATABASE_URL'
export const DB_URL_AUTH_TOKEN_ENV = 'WHITEBOARD_DATABASE_AUTH_TOKEN'

/** Where this process's database lives, and what it needs to open it. */
export interface DatabaseLocation {
  url: string
  /** Absent rather than empty when none is configured: an empty token is a
   *  credential the driver would send and the server would reject, which
   *  reads as a server problem rather than a missing setting. */
  authToken?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * The database this instance opens.
 *
 * Defaults to the file in the data directory, which is what a single daemon
 * has always used and what every existing install still gets. More than one
 * instance cannot share that file — SQLite's locking does not survive a
 * network filesystem, and two machines cannot share a local one at all — so
 * an operator running several instances points them at one libSQL server
 * instead. Without this the rest of ADR-0020 is unreachable in practice:
 * every guarantee it builds is about instances looking at ONE record.
 *
 * Blobs are a different question and deliberately not this one. `FsBlobStore`
 * is content-addressed (sha-256, sharded) and version thumbnails are keyed by
 * version id, so two instances writing the same blob write identical bytes to
 * the same path — a shared volume genuinely works for them, and an object
 * store is an optimisation rather than a prerequisite.
 *
 * **Throws rather than falling back.** A misconfigured URL that quietly
 * became the local file would give each instance its OWN database: they would
 * diverge with no error anywhere, and every guarantee this design rests on
 * would silently not apply because the instances were never looking at the
 * same record. Refusing to start is the far kinder failure.
 */
export function resolveDatabaseLocation(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseLocation {
  const raw = env[DB_URL_ENV]?.trim()
  if (raw === undefined || raw === '') {
    return { url: `file:${join(dataDir, DB_FILENAME)}` }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${DB_URL_ENV} is not a URL`)
  }

  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${DB_URL_ENV} may only use http: for a loopback host; use libsql: or https: for a remote database`,
    )
  }
  if (!['libsql:', 'https:', 'http:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`${DB_URL_ENV} must be a libsql:, https:, http: or file: URL`)
  }

  const authToken = env[DB_URL_AUTH_TOKEN_ENV]?.trim()
  return { url: raw, ...(authToken === undefined || authToken === '' ? {} : { authToken }) }
}

/**
 * Whether copying `dataDir` would carry the rows with it.
 *
 * Every whole-directory operation — `whiteboard server backup` and its
 * restore — rests on an assumption it never states: that the database is a
 * file inside the directory being copied. That held for every install until
 * `WHITEBOARD_DATABASE_URL` made the location configurable, and nothing
 * re-asked it. Measured: with a remote database configured, `server backup`
 * reported `{"ok":true}` over a backup holding blobs alone.
 *
 * **Fail closed.** `true` is the answer that lets a whole-directory copy
 * proceed, so anything unreadable answers `false` — a refused backup is
 * recoverable, one the operator believes in is not.
 */
export function databaseIsInsideDataDir(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let url: string
  try {
    url = resolveDatabaseLocation(dataDir, env).url
  } catch {
    // An unusable value aborts startup elsewhere; here it simply is not a
    // path inside the directory.
    return false
  }
  if (!url.startsWith('file:')) return false
  try {
    return fileURLToPath(url) === join(dataDir, DB_FILENAME)
  } catch {
    // A relative or otherwise non-path file: URL. Whatever it names, this
    // function cannot show it is inside.
    return false
  }
}
