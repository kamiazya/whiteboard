import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createClient } from '@libsql/client'
import { resolveDatabaseLocation } from './location.js'

/**
 * Capture the rows into one self-contained database file.
 *
 * Taken THROUGH the database rather than by copying its files (ADR-0021
 * decision 3). A file copy has to treat `whiteboard.db`, `-wal` and `-shm` as
 * one artifact and get all three: in WAL mode the newest commits live in the
 * `-wal` until a checkpoint folds them back, so copying the main file alone
 * loses them silently — measured at 4977 of 5000 rows. `VACUUM INTO` writes a
 * single file with everything already folded in, so nothing downstream needs
 * to know the sidecars exist.
 *
 * It is also what lets the snapshot be taken while the daemon serves. This
 * opens its OWN connection, exactly as a host-side `whiteboard server backup`
 * does, which is why the database is opened in WAL: under the default
 * rollback journal that connection is refused outright against a database
 * under active write (`SQLITE_BUSY`, 3 attempts of 3).
 */
export async function snapshotDatabaseInto(dataDir: string, destPath: string): Promise<void> {
  // `VACUUM INTO` fails on an existing target with a message an operator
  // cannot act on. Say what is actually wrong.
  if (await pathExists(destPath)) {
    throw new Error(`snapshot destination already exists: ${destPath}`)
  }
  await mkdir(dirname(destPath), { recursive: true })

  const client = createClient(resolveDatabaseLocation(dataDir))
  try {
    // The path is interpolated because SQLite does not accept a bound
    // parameter here. It is never operator input: every caller derives it
    // from a directory this process has already validated, and a quote in it
    // would break the statement rather than extend it.
    await client.execute({ sql: `VACUUM INTO '${destPath.replaceAll("'", "''")}'`, args: [] })
  } finally {
    client.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
