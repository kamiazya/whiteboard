import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR } from '../shared/data-dir-secure.js'

export interface DaemonRecord {
  pid: number
  port: number
  token: string
  version: string
  startedAt: string
}

const DAEMON_RECORD_FILENAME = 'daemon.json'

export function getDaemonRecordPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, DAEMON_RECORD_FILENAME)
}

export async function loadDaemonRecord(dataDir: string = DATA_DIR): Promise<DaemonRecord | null> {
  try {
    const raw = JSON.parse(await readFile(getDaemonRecordPath(dataDir), 'utf-8')) as Partial<DaemonRecord>
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.port !== 'number' ||
      typeof raw.token !== 'string' ||
      typeof raw.version !== 'string' ||
      typeof raw.startedAt !== 'string'
    ) {
      return null
    }
    return {
      pid: raw.pid,
      port: raw.port,
      token: raw.token,
      version: raw.version,
      startedAt: raw.startedAt,
    }
  } catch {
    return null
  }
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
