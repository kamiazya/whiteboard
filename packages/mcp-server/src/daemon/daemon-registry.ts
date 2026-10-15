import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  assertDataDirOwnedByUser,
  DATA_DIR,
  readFileOwnedByUser,
} from '../shared/data-dir-secure.js'
import { writeFileAtomic } from '../shared/write-file-atomic.js'
import { daemonLiveness } from './daemon-liveness.js'
import {
  type DaemonRecord,
  type DaemonRecordWrite,
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
 * What a record this build cannot interpret still says about its daemon: the
 * pid it must, and whatever else of the liveness fields reads as itself.
 */
const recordedDaemonSchema = daemonRecordBaseSchema.pick({ pid: true }).extend({
  startedAt: z.string().optional().catch(undefined),
  socketPath: z.string().min(1).optional().catch(undefined),
  token: z.string().min(1).optional().catch(undefined),
})

/**
 * The running daemon's record, or `null` when there is none.
 *
 * `null` is what a caller reads as "no daemon is running" before it deletes
 * the record and starts a new daemon, so it is only returned where that is safe:
 * ENOENT; text that is not a JSON object (writes are atomic, so that is a
 * damaged file, not a half-written one, and it names no process); and a
 * record this build cannot interpret whose daemon `daemonLiveness` finds gone
 * — its pid dead, or taken by a later process with nothing answering on the
 * socket it names.
 *
 * Two cases throw instead, each naming the file, because answering `null`
 * would start a second daemon beside one still serving:
 * - the record exists but cannot be READ;
 * - the record cannot be interpreted but its daemon is still there —
 *   likeliest one of another version, whose record this schema refuses.
 * Where the platform cannot tell a process's start time, a live pid can also
 * be an unrelated process that reused it; the message says to remove the file
 * then, since only a person can tell the two apart.
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
  const named = recordedDaemonSchema.safeParse(raw)
  if (!named.success) return null
  const liveness = await daemonLiveness(named.data)
  if (liveness === 'unconfirmed') {
    throw new Error(
      `the daemon record ${path} cannot be interpreted by this version, and a daemon answers on its socket ${named.data.socketPath}. ` +
        'If that is a whiteboard daemon of another version, stop it with that version.',
    )
  }
  if (liveness === 'running') {
    throw new Error(
      `the daemon record ${path} cannot be interpreted by this version, but names pid ${named.data.pid}, which is running. ` +
        'If that is a whiteboard daemon of another version, stop it with that version; if it is not a daemon, remove the file.',
    )
  }
  return null
}

/**
 * Takes `DaemonRecordWrite`, not `DaemonRecord`: `launch` is optional only so a
 * reader can still name a daemon that predates it. A record written without it
 * would announce a build as watch-mode source.
 */
export async function saveDaemonRecord(
  record: DaemonRecordWrite,
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
