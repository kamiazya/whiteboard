import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR } from '../shared/data-dir-secure.js'
import {
  type DaemonRecord,
  daemonRecordBaseSchema,
  daemonRecordSchema,
} from './daemon-record-schema.js'

export type { DaemonRecord } from './daemon-record-schema.js'

/**
 * Exported so `backupDataDir` can keep it OUT of a backup. The file holds the
 * Bearer token the daemon authenticates HTTP and WS with — which is why it is
 * written 0o600 below — and a backup directory is the opposite of owner-only.
 */
export const DAEMON_RECORD_FILENAME = 'daemon.json'

export function getDaemonRecordPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, DAEMON_RECORD_FILENAME)
}

/**
 * The running daemon's record, or `null` when there is none.
 *
 * `null` is what `ensure-daemon` answers by deleting the record and spawning
 * a new daemon with a new token, so it is only returned where that is safe:
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
  const path = getDaemonRecordPath(dataDir)
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`the daemon record ${path} exists but cannot be read`, { cause: err })
  }
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
  const target = getDaemonRecordPath(dataDir)
  const temp = `${target}.tmp`
  // daemon.json contains the Bearer token used for HTTP / WS auth, so keep it
  // owner-only (0o600). Windows ignores POSIX modes here and relies on ACLs.
  await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
  await rename(temp, target)
  if (platform() !== 'win32') {
    try {
      // writeFile can still inherit a looser mode through umask, so tighten it again.
      await chmod(target, 0o600)
    } catch {
      /* Best-effort only; startup should continue even if this fails. */
    }
  }
}

export async function deleteDaemonRecord(dataDir: string = DATA_DIR): Promise<void> {
  await rm(getDaemonRecordPath(dataDir), { force: true })
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
