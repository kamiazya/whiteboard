import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Exported so `backupDataDir` can keep this command's own bookkeeping out
 *  of its own output. */
export const BACKUP_MARKER_FILENAME = 'backup-in-progress.json'

const markerSchema = z.object({
  schemaVersion: z.literal(2),
  /**
   * Who is backing up, for a human reading the file. Nothing decides on it —
   * liveness is `expiresAt` alone, because the reader has no way to check
   * anything about a writer in another container.
   */
  holder: z.string(),
  startedAt: z.string(),
  /** Unix milliseconds. Pushed out for as long as the backup runs. */
  expiresAt: z.number().int().positive(),
})

/**
 * How long a marker is honoured without being refreshed, and how often the
 * running backup pushes it out.
 *
 * The TTL is the whole cost of a hard kill: GC stands down for at most this
 * long after a backup dies. The refresh is well inside it so a stalled event
 * loop has room to miss a beat without expiring a live backup's own marker.
 */
const DEFAULT_TTL_MS = 60_000
const DEFAULT_REFRESH_MS = 15_000

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
 * so no in-memory lock reaches across. It stays the filesystem rather than
 * moving to the `leases` table for the same reason — the CLI runs where the
 * daemon's environment is not loaded, so the data directory is the only thing
 * both ends are certain to agree on.
 *
 * Liveness is an EXPIRY, not the writer's pid. A pid is only meaningful
 * inside one pid namespace, and the writer here is routinely in another
 * container: the number then matches nothing (GC deletes underneath a live
 * backup) or matches an unrelated local process (GC waits on a backup that
 * ended hours ago), with no way to tell which. A deadline the live backup
 * keeps pushing out means the same thing to every reader.
 *
 * **Fails OPEN**, which is the opposite of every other guard in this area and
 * deliberate. The cost of wrongly believing a backup is running is that GC
 * never collects again — an unbounded disk leak, from a file nobody is
 * maintaining. The cost of wrongly believing none is running is one skipped
 * stand-down in a window measured in seconds. So an unreadable marker, or an
 * expired one, is treated as no marker at all.
 */
export async function backupIsInProgress(
  dataDir: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
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
  return parsed.expiresAt > nowMs
}

export interface BackupMarkerOptions {
  /** Identifies the writer in the file. Not used for any decision. */
  holder?: string
  ttlMs?: number
  refreshEveryMs?: number
}

/** Run `body` with the marker in place, removing it however `body` ends. */
export async function withBackupMarker<T>(
  dataDir: string,
  body: () => Promise<T>,
  options: BackupMarkerOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const refreshEveryMs = options.refreshEveryMs ?? DEFAULT_REFRESH_MS
  const startedAt = new Date().toISOString()
  const holder = options.holder ?? `pid ${process.pid}`

  // A directory this process cannot write to is one the backup is about to
  // fail on anyway; not being able to ask GC to wait is not the error worth
  // reporting, so the backup proceeds without the stand-down.
  const write = async (): Promise<void> => {
    const marker = {
      schemaVersion: 2,
      holder,
      startedAt,
      expiresAt: Date.now() + ttlMs,
    } satisfies z.infer<typeof markerSchema>
    await writeFile(markerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`, 'utf8').catch(
      () => {},
    )
  }

  await write()
  // Refreshed for as long as the pass runs, because how long a backup takes
  // is a property of the data. Without this a long copy expires its own
  // marker and GC resumes underneath it, which is the window this closes.
  // unref'd: keeping a marker warm must never hold a process open.
  const refresh = setInterval(() => {
    void write()
  }, refreshEveryMs)
  refresh.unref()

  try {
    return await body()
  } finally {
    clearInterval(refresh)
    await rm(markerPath(dataDir), { force: true }).catch(() => {})
  }
}
