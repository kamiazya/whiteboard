import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getLogger } from '../../log.js'

const log = getLogger('database-location-record')

const LOCATION_RECORD_FILENAME = 'storage.json'

/**
 * What the deployment recorded about where its rows live.
 *
 * Deliberately one boolean and no URL. A connection string can carry
 * userinfo, this file sits in the directory a backup copies wholesale, and
 * the only question anyone asks of it is whether copying the directory
 * carries the rows.
 */
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  database: z.object({ inDataDir: z.boolean() }),
})

export interface DatabaseLocationRecord {
  readonly inDataDir: boolean
}

function recordPath(dataDir: string): string {
  return join(dataDir, LOCATION_RECORD_FILENAME)
}

/**
 * The durable answer to "where does this deployment keep its rows".
 *
 * Every other source fails the case that needs one. The environment belongs
 * to whoever runs the command, and `whiteboard server backup` is documented
 * as a host-side invocation where a container's `--env-file` is not loaded.
 * The directory answers only "a database file is here", which a stale
 * `whiteboard.db` left behind when an operator moved to libSQL satisfies
 * while the live rows are elsewhere. And `server-mode.json` is deleted on
 * graceful shutdown, which that same documented flow performs first.
 *
 * So this is written by whoever OPENS the database and is never removed:
 * being readable after the server is stopped is the entire point.
 */
export async function readDatabaseLocationRecord(
  dataDir: string,
): Promise<DatabaseLocationRecord | null> {
  let raw: string
  try {
    raw = await readFile(recordPath(dataDir), 'utf8')
  } catch {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = recordSchema.safeParse(json)
  // Fail closed on anything unreadable — a corrupt file, or a version this
  // build does not know. `null` returns the caller to the weaker
  // environment-and-directory answer it had before this record existed,
  // never to a confident "the rows are here".
  if (!parsed.success) return null
  return { inDataDir: parsed.data.database.inDataDir }
}

/**
 * Record where this process just opened its database.
 *
 * Never throws and never rejects. A data directory that cannot hold this file
 * is a directory the server has other problems with; failing to note the
 * location must not be one of them, because the alternative is a server that
 * will not start over a hint.
 */
export async function writeDatabaseLocationRecord(
  dataDir: string,
  inDataDir: boolean,
): Promise<void> {
  const record: z.infer<typeof recordSchema> = {
    schemaVersion: 1,
    database: { inDataDir },
  }
  try {
    await writeFile(recordPath(dataDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch (err) {
    log.warning({ dataDir, err }, 'could not record the database location')
  }
}
