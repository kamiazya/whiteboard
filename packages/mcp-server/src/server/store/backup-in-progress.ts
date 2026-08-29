import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Exported so `backupDataDir` can keep this command's own bookkeeping out
 *  of its own output. */
export const BACKUP_MARKER_FILENAME = 'backup-in-progress.json'

const markerSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  startedAt: z.string(),
})

function markerPath(dataDir: string): string {
  return join(dataDir, BACKUP_MARKER_FILENAME)
}

/**
 * Whether a backup is currently assembling this data directory.
 *
 * File-GC asks before deleting. A backup captures the rows as a snapshot and
 * the uploads as a directory copy, and those are two moments; a GC pass
 * between them that unlinks a file the snapshot still references leaves a
 * backup restoring to a document that points at nothing — silently, because
 * every step reported success. That is ADR-0021 decision 6's far end
 * ("retention must not delete behind") in the shape this system has today.
 *
 * The channel is the filesystem because it has to be: `whiteboard server
 * backup` runs host-side as a SEPARATE process from the daemon that runs GC,
 * so no in-memory lock reaches across.
 *
 * **Fails OPEN**, which is the opposite of every other guard in this area and
 * deliberate. The cost of wrongly believing a backup is running is that GC
 * never collects again — an unbounded disk leak, from a file nobody is
 * maintaining. The cost of wrongly believing none is running is one skipped
 * stand-down in a window measured in seconds. So an unreadable marker, or one
 * whose writer is gone, is treated as no marker at all.
 */
export async function backupIsInProgress(dataDir: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(markerPath(dataDir), 'utf8')
  } catch {
    return false
  }
  let parsed: z.infer<typeof markerSchema>
  try {
    const result = markerSchema.safeParse(JSON.parse(raw))
    if (!result.success) return false
    parsed = result.data
  } catch {
    return false
  }
  // A marker whose writer is gone is one nobody is honouring — a backup that
  // was killed. Without this check a single crash stops collection forever.
  return processIsAlive(parsed.pid)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Run `body` with the marker in place, removing it however `body` ends. */
export async function withBackupMarker<T>(dataDir: string, body: () => Promise<T>): Promise<T> {
  const marker = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  } satisfies z.infer<typeof markerSchema>
  // A directory this process cannot write to is one the backup is about to
  // fail on anyway; not being able to ask GC to wait is not the error worth
  // reporting, so the backup proceeds without the stand-down.
  await writeFile(markerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8').catch(
    () => {},
  )
  try {
    return await body()
  } finally {
    await rm(markerPath(dataDir), { force: true }).catch(() => {})
  }
}
