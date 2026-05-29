import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// Daily-rotated daemon-YYYY-MM-DD.log files accumulate forever today; this
// helper drops files older than retainDays (default 14). Filename-driven
// (rather than mtime-driven) so a file deliberately left untouched still
// honours the rotation contract — and it costs no stat() per file in the
// common case.

export const DEFAULT_DAEMON_LOG_RETAIN_DAYS = 14

const FILENAME_RE = /^daemon-(\d{4})-(\d{2})-(\d{2})\.log$/

export interface PurgeOldDaemonLogsResult {
  purgedCount: number
  purgedBytes: number
}

export async function purgeOldDaemonLogs(
  dataDir: string,
  options: { retainDays?: number; now?: Date } = {},
): Promise<PurgeOldDaemonLogsResult> {
  const retainDays = options.retainDays ?? DEFAULT_DAEMON_LOG_RETAIN_DAYS
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - retainDays * 24 * 60 * 60 * 1000

  const dir = join(dataDir, 'logs')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // No logs dir yet — the daemon startup path creates it later.
    return { purgedCount: 0, purgedBytes: 0 }
  }

  let purgedCount = 0
  let purgedBytes = 0
  for (const entry of entries) {
    const match = FILENAME_RE.exec(entry)
    if (!match) continue
    const fileDateUtcMs = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    )
    if (fileDateUtcMs >= cutoff) continue
    const path = join(dir, entry)
    try {
      const info = await stat(path)
      await unlink(path)
      purgedCount += 1
      purgedBytes += info.size
    } catch {
      // Best-effort: missing / locked files are skipped. Next run retries.
    }
  }
  return { purgedCount, purgedBytes }
}
