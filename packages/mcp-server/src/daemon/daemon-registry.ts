import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertDataDirOwnedByUser,
  DATA_DIR,
  readFileOwnedByUser,
} from '../shared/data-dir-secure.js'
import { isPidAlive } from '../shared/process-alive.js'
import { writeFileAtomic } from '../shared/write-file-atomic.js'
import {
  type DaemonRecord,
  daemonRecordBaseSchema,
  daemonRecordSchema,
} from './daemon-record-schema.js'

export type { DaemonRecord } from './daemon-record-schema.js'

/**
 * Exported so `backupDataDir` can keep it OUT of a backup. The file holds the
 * Bearer token the daemon authenticates its HTTP routes and sync stream with — which is why it is
 * written 0o600 below — and a backup directory is the opposite of owner-only.
 */
export const DAEMON_RECORD_FILENAME = 'daemon.json'

export function getDaemonRecordPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, DAEMON_RECORD_FILENAME)
}

/**
 * The running daemon's record, or `null` when there is none.
 *
 * `null` is what a caller reads as "no daemon is running" before it deletes
 * the record and starts a new daemon, so it is only returned where that is safe:
 * ENOENT; text that is not a JSON object (writes are atomic, so that is a
 * damaged file, not a half-written one, and it names no process); and a
 * record this build cannot interpret whose `pid` is not running.
 *
 * Two cases throw instead, each naming the file, because answering `null`
 * would start a second daemon beside one still serving:
 * - the record exists but cannot be READ;
 * - the record cannot be interpreted but names a pid that is ALIVE — likeliest
 *   a daemon of another version, whose record this schema refuses.
 * A live pid can also be an unrelated process that reused it; the message
 * says to remove the file then, since only a person can tell the two apart.
 */
export async function loadDaemonRecord(dataDir: string = DATA_DIR): Promise<DaemonRecord | null> {
  assertDataDirOwnedByUser(dataDir)
  const path = getDaemonRecordPath(dataDir)
  let read: Awaited<ReturnType<typeof readFileOwnedByUser>>
  try {
    read = await readFileOwnedByUser(path)
  } catch (err) {
    throw new Error(`the daemon record ${path} exists but cannot be read`, { cause: err })
  }
  if (read.kind === 'missing') return null
  if (read.kind === 'not-owned') throw new Error(read.message)
  const text = read.text
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const result = daemonRecordSchema.safeParse(raw)
  if (result.success) return result.data
  const named = daemonRecordBaseSchema.pick({ pid: true }).safeParse(raw)
  if (named.success && isPidAlive(named.data.pid)) {
    throw new Error(
      `the daemon record ${path} cannot be interpreted by this version, but names pid ${named.data.pid}, which is running. ` +
        'If that is a whiteboard daemon of another version, stop it with that version; if it is not a daemon, remove the file.',
    )
  }
  return null
}

export async function saveDaemonRecord(
  record: DaemonRecord,
  dataDir: string = DATA_DIR,
): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  // daemon.json contains the Bearer token used to authenticate HTTP routes and the sync stream, so keep it
  // owner-only (0o600).
  await writeFileAtomic(getDaemonRecordPath(dataDir), JSON.stringify(record, null, 2), {
    mode: 0o600,
  })
}

export async function deleteDaemonRecord(dataDir: string = DATA_DIR): Promise<void> {
  await rm(getDaemonRecordPath(dataDir), { force: true })
}
