// Cross-process exclusion for a data directory's startup migrations. kysely's
// own migration lock is in-process and its SQLite DDL runs outside a
// transaction, so two servers opening one data dir at once (a stdio agent
// beside a daemon, `pnpm mcp` twice) would otherwise apply the same migration
// twice: one dies on a schema error at a random step, and a table-rebuilding
// migration can run its whole body a second time before failing on its log row.

import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isErrnoCode } from '../../../shared/errno.js'
import {
  describeHolder,
  type HolderJudgement,
  judgeLockHolder,
  lockHolderHost,
  sameLockFile,
} from '../../../shared/stale-lock.js'
import { getLogger } from '../../log.js'

const log = getLogger('migration-lock')

export const MIGRATION_LOCK_FILENAME = 'migration.lock'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 50

export interface MigrationLockOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
}

// The lock's text: the holder's pid, then the host whose pid namespace issued
// it. A lock with no second line is judged by its pid alone.
const ownLockText = (): string => `${process.pid}\n${lockHolderHost()}`

function judgeLockText(text: string, mtimeMs: number): HolderJudgement {
  if (text === '') return judgeLockHolder('unwritten', mtimeMs)
  const [pidLine = '', host] = text.split('\n')
  const pid = Number(pidLine)
  return judgeLockHolder(
    { pid: Number.isInteger(pid) ? pid : null, ...(host ? { host } : {}) },
    mtimeMs,
  )
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
    await handle.writeFile(ownLockText())
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
  judged: { dev: number; ino: number; mtimeMs: number },
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
    if (!sameLockFile(moved, judged)) {
      await link(aside, lockPath).catch(() => {})
    }
  } finally {
    await unlink(aside).catch(() => {})
  }
  return 'retry'
}

// Only while the lock still names this process — pid and host both — so a
// holder whose lock was replaced never deletes its successor's.
async function release(lockPath: string): Promise<void> {
  try {
    if ((await readFile(lockPath, 'utf8')) === ownLockText()) await unlink(lockPath)
  } catch {
    // Absent or unremovable: the stale-holder check is the backstop.
  }
}

// One look at whoever holds the lock: 'retry' when it vanished or was replaced,
// so the caller retries the create at once; 'unlocked' when a stale one cannot
// be moved; else the live holder's pid.
async function inspectHolder(
  lockPath: string,
): Promise<{ holderPid: number | null; host?: string } | 'retry' | 'unlocked'> {
  let text: string
  let judged: Awaited<ReturnType<typeof stat>>
  try {
    text = await readFile(lockPath, 'utf8')
    judged = await stat(lockPath)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return 'retry'
    throw err
  }
  const verdict = judgeLockText(text, judged.mtimeMs)
  if (verdict.kind === 'held') return verdict
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
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${describeHolder(holder)} ` +
          `to finish migrating the data directory ${dataDir}. ` +
          `If no whiteboard process is running on it, remove ${lockPath} and restart.`,
      )
    }
    // At the default log level: a caller that gives up before the deadline
    // (a launcher's own startup bound) must find why this process is waiting.
    if (!announced) {
      announced = true
      log.warning(
        {
          lockPath,
          holderPid: holder.holderPid,
          holderHost: holder.host,
          deadline: new Date(deadline).toISOString(),
        },
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
