// Cross-process exclusion for a data directory's startup migrations. kysely's
// own migration lock is in-process and its SQLite DDL runs outside a
// transaction, so two servers opening one data dir at once (a stdio agent
// beside a daemon, `pnpm mcp` twice) would otherwise apply the same migration
// twice: one dies on a schema error at a random step, and a table-rebuilding
// migration can run its whole body a second time before failing on its log row.

import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isErrnoCode } from '../../../shared/errno.js'
import { isPidAlive } from '../../../shared/process-alive.js'
import { getLogger } from '../../log.js'

const log = getLogger('migration-lock')

export const MIGRATION_LOCK_FILENAME = 'migration.lock'

// The create and the pid write are two calls, so a racing opener can read the
// file between them; past this an empty file was left by a holder that died there.
const EMPTY_LOCK_GRACE_MS = 5_000

// A holder writes the lock after it started, so its process cannot have started
// after the lock's mtime. The slack absorbs `btime`'s whole-second resolution.
const START_SLACK_MS = 5_000

// Linux's USER_HZ, the unit of /proc/<pid>/stat's start time, is 100 on every
// architecture the kernel ships (it is fixed for the userspace ABI).
const USER_HZ = 100

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 50

export interface MigrationLockOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
}

// When `pid` started, from /proc. Null where /proc is absent (macOS, Windows):
// the caller then cannot tell a reused pid and keeps treating it as the holder,
// which costs a wait rather than a second migrator.
async function readProcessStartMs(pid: number): Promise<number | null> {
  try {
    const procStat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // The command name is parenthesised and may hold spaces and parentheses,
    // so fields are counted from the LAST `)`: field 3 follows it.
    const fields = procStat.slice(procStat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(fields[22 - 3])
    const btime = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))
    if (!Number.isFinite(startTicks) || btime === null) return null
    return Number(btime[1]) * 1000 + (startTicks * 1000) / USER_HZ
  } catch {
    return null
  }
}

type Judgement =
  | { readonly kind: 'held'; readonly holderPid: number | null }
  | { readonly kind: 'gone'; readonly holderPid: number | null; readonly reason: string }

async function judgeHolder(text: string, mtimeMs: number): Promise<Judgement> {
  if (text === '') {
    return Date.now() - mtimeMs > EMPTY_LOCK_GRACE_MS
      ? { kind: 'gone', holderPid: null, reason: 'empty lock file' }
      : { kind: 'held', holderPid: null }
  }
  const pid = Number(text)
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: 'gone', holderPid: null, reason: 'lock file names no pid' }
  }
  if (!isPidAlive(pid)) return { kind: 'gone', holderPid: pid, reason: 'holder exited' }
  const started = await readProcessStartMs(pid)
  if (started !== null && started > mtimeMs + START_SLACK_MS) {
    return { kind: 'gone', holderPid: pid, reason: 'holder pid reused by a later process' }
  }
  return { kind: 'held', holderPid: pid }
}

async function tryCreate(lockPath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST')) return false
    throw err
  }
  try {
    await handle.writeFile(String(process.pid))
  } finally {
    await handle.close()
  }
  return true
}

// A data directory this process cannot create a file in cannot hold the lock
// either; the migrations ran unlocked before the lock existed, so that is what
// such a directory still gets, with a warning, rather than a refused startup.
const cannotWriteHere = (err: unknown): boolean =>
  isErrnoCode(err, 'EACCES') || isErrnoCode(err, 'EPERM') || isErrnoCode(err, 'EROFS')

async function tryCreateOrSkip(lockPath: string): Promise<boolean> {
  try {
    return await tryCreate(lockPath)
  } catch (err) {
    if (!cannotWriteHere(err)) throw err
    log.warning({ lockPath, err }, 'cannot create the migration lock; migrating without it')
    return true
  }
}

// Moves a judged-stale lock aside. `rename` succeeds for one of two racing
// replacers only, and the moved file must still be the one judged — another
// replacer may have moved that one and created its own in between — so a
// different inode goes back with `link`, which never overwrites. A directory
// that refuses the rename cannot take a new lock either, so it migrates
// unlocked, as a directory that refuses the create does; any other failure is
// thrown rather than retried at once, which would spin without a deadline.
async function replaceStale(
  lockPath: string,
  judged: { dev: number; ino: number },
): Promise<'retry' | 'unlocked'> {
  const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`
  try {
    await rename(lockPath, aside)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return 'retry'
    if (!cannotWriteHere(err)) throw err
    log.warning({ lockPath, err }, 'cannot replace the stale migration lock; migrating without it')
    return 'unlocked'
  }
  try {
    const moved = await stat(aside)
    if (moved.dev !== judged.dev || moved.ino !== judged.ino) {
      await link(aside, lockPath).catch(() => {})
    }
  } finally {
    await unlink(aside).catch(() => {})
  }
  return 'retry'
}

// Only while the lock still names this process, so a holder whose lock was
// replaced never deletes its successor's.
async function release(lockPath: string): Promise<void> {
  try {
    if ((await readFile(lockPath, 'utf8')) === String(process.pid)) await unlink(lockPath)
  } catch {
    // Absent or unremovable: the stale-holder check is the backstop.
  }
}

// One look at whoever holds the lock: 'retry' when it vanished or was replaced,
// so the caller retries the create at once; 'unlocked' when a stale one cannot
// be moved; else the live holder's pid.
async function inspectHolder(
  lockPath: string,
): Promise<{ holderPid: number | null } | 'retry' | 'unlocked'> {
  let text: string
  let judged: Awaited<ReturnType<typeof stat>>
  try {
    text = await readFile(lockPath, 'utf8')
    judged = await stat(lockPath)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return 'retry'
    throw err
  }
  const verdict = await judgeHolder(text, judged.mtimeMs)
  if (verdict.kind === 'held') return { holderPid: verdict.holderPid }
  log.warning(
    { lockPath, holderPid: verdict.holderPid, reason: verdict.reason },
    'replacing a migration lock whose holder is gone',
  )
  return replaceStale(lockPath, judged)
}

/**
 * Runs `fn` holding `<dataDir>/migration.lock`. A live holder is waited for,
 * up to `timeoutMs`; one that exited, or whose pid a later process has taken,
 * is replaced. The data directory must already exist.
 */
export async function withMigrationLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
  options: MigrationLockOptions = {},
): Promise<T> {
  const lockPath = join(dataDir, MIGRATION_LOCK_FILENAME)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs
  let announced = false
  while (!(await tryCreateOrSkip(lockPath))) {
    const holder = await inspectHolder(lockPath)
    if (holder === 'unlocked') return fn()
    if (holder === 'retry') continue
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for process ` +
          `${holder.holderPid ?? '(unknown)'} to finish migrating the data directory ${dataDir}. ` +
          `If no whiteboard process is running on it, remove ${lockPath} and restart.`,
      )
    }
    if (!announced) {
      announced = true
      log.info(
        { lockPath, holderPid: holder.holderPid },
        'waiting for another process to finish migrating this data directory',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  try {
    return await fn()
  } finally {
    await release(lockPath)
  }
}
