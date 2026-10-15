// Cross-process mutual exclusion built on `mkdir()`'s atomic guarantee: a
// second process racing to create the same directory gets EEXIST, so
// whichever process wins the mkdir is the sole lock holder. No external
// lockfile dependency needed.
//
// A lock left behind by a holder that has since died (crashed daemon,
// killed CLI) would otherwise wedge every future acquirer forever, so the
// holder records itself in the lock and a waiter reclaims the lock once
// `stale-lock.ts` judges that holder gone — including one that died before
// recording itself at all.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isErrnoCode } from './errno.js'
import {
  describeHolder,
  type HolderJudgement,
  judgeLockHolder,
  lockHolderHost,
} from './stale-lock.js'

const LOCK_OWNER_FILENAME = 'owner.json'

const lockOwnerSchema = z.object({
  pid: z.number(),
  // When the owner wrote this: its process started before, so a live pid
  // that started after it was reused.
  startedAt: z.string(),
  // Optional for a reader: an owner written before it was recorded is judged
  // by its pid alone.
  host: z.string().optional(),
})

type LockOwner = z.infer<typeof lockOwnerSchema>

async function writeOwnerMetadata(lockDirPath: string): Promise<LockOwner> {
  const owner: LockOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: lockHolderHost(),
  }
  await writeFile(join(lockDirPath, LOCK_OWNER_FILENAME), JSON.stringify(owner, null, 2))
  return owner
}

// The owner file: absent, or not yet a whole record (its write is not atomic),
// reads as null — a holder still writing it, or one that died first. Any
// other read failure says nothing about the holder, so it reads as one.
async function loadOwnerMetadata(lockDirPath: string): Promise<LockOwner | null | 'unreadable'> {
  let text: string
  try {
    text = await readFile(join(lockDirPath, LOCK_OWNER_FILENAME), 'utf-8')
  } catch (err) {
    return isErrnoCode(err, 'ENOENT') ? null : 'unreadable'
  }
  try {
    const result = lockOwnerSchema.safeParse(JSON.parse(text))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

// The lock's holder, judged. An owner file not yet written is dated by the
// directory's own mtime; a lock directory already gone is null.
async function judgeLock(lockDirPath: string): Promise<HolderJudgement | null> {
  const owner = await loadOwnerMetadata(lockDirPath)
  if (owner === 'unreadable') return { kind: 'held', holderPid: null }
  if (owner !== null) {
    return judgeLockHolder(
      { pid: owner.pid, ...(owner.host === undefined ? {} : { host: owner.host }) },
      Date.parse(owner.startedAt),
    )
  }
  try {
    return judgeLockHolder('unwritten', (await stat(lockDirPath)).mtimeMs)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return null
    throw err
  }
}

// Reclaims a lock whose holder is judged gone. A plain rm-and-retry
// here would let two waiters both observe the dead pid, with the slower rm
// destroying the lock the faster waiter has already re-acquired — breaking
// mutual exclusion. Reclamation is therefore serialized through a second
// mkdir lock (`<lock>.break`): only the waiter holding the break lock may
// remove the main lock, and it re-checks the owner while holding it. That
// re-check is sound because while the break lock is held the main lock
// cannot transition dead→live: acquiring requires the directory to be gone,
// and removing it requires the break lock. Losers of the break-lock race
// wait and retry. A break lock orphaned by a crash is
// itself removed once its holder is judged gone. Answers whether the main lock
// was removed, so a caller that lost the race knows it has not progressed.
async function reclaimDeadLock(lockDirPath: string): Promise<boolean> {
  const breakLockPath = `${lockDirPath}.break`
  try {
    await mkdir(breakLockPath, { recursive: false })
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST') && (await judgeLock(breakLockPath))?.kind === 'gone') {
      await rm(breakLockPath, { recursive: true, force: true })
    }
    return false
  }
  try {
    await writeOwnerMetadata(breakLockPath)
    if ((await judgeLock(lockDirPath))?.kind === 'gone') {
      await rm(lockDirPath, { recursive: true, force: true })
      return true
    }
    return false
  } finally {
    await rm(breakLockPath, { recursive: true, force: true })
  }
}

export interface MkdirLockOptions {
  retryDelayMs?: number
  timeoutMs?: number
}

/**
 * One attempt at the exclusive create. `false` means somebody else holds it,
 * which is the only failure this function answers for — anything other than
 * EEXIST is a real filesystem error and propagates.
 */
async function tryAcquire(lockDirPath: string): Promise<LockOwner | null> {
  try {
    await mkdir(lockDirPath, { recursive: false })
  } catch (err) {
    if (!isErrnoCode(err, 'EEXIST')) throw err
    return null
  }
  try {
    return await writeOwnerMetadata(lockDirPath)
  } catch (err) {
    await rm(lockDirPath, { recursive: true, force: true })
    throw err
  }
}

// Only while the lock still names this holder, so one whose lock was
// reclaimed never deletes its successor's.
async function release(lockDirPath: string, owner: LockOwner): Promise<void> {
  const current = await loadOwnerMetadata(lockDirPath)
  if (
    typeof current === 'object' &&
    current?.pid === owner.pid &&
    current.host === owner.host &&
    current.startedAt === owner.startedAt
  ) {
    await rm(lockDirPath, { recursive: true, force: true })
  }
}

/**
 * Wait out the current holder, or take the lock from it.
 *
 * A holder judged gone never released — the process died holding it — so
 * the lock is reclaimed immediately rather than waited out to the deadline,
 * which would leave every caller blocked until the timeout on every
 * subsequent run. A reclamation that lost the break-lock race has taken
 * nothing, so it waits and answers to the deadline like any other contended
 * attempt rather than spinning on a lock it cannot take.
 */
async function waitForHolder(
  lockDirPath: string,
  deadline: number,
  retryDelayMs: number,
): Promise<void> {
  const holder = await judgeLock(lockDirPath)
  if (holder === null) return
  if (holder.kind === 'gone' && (await reclaimDeadLock(lockDirPath))) return
  if (Date.now() >= deadline) {
    throw new Error(
      `Lock timeout waiting for: ${lockDirPath}, held by ${describeHolder(holder)}. ` +
        'If no whiteboard process is using it, remove that directory and retry.',
    )
  }
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
}

// Runs `fn` while holding the exclusive lock at `lockDirPath`. Callers must
// ensure the lock's parent directory already exists. Waits (polling every
// `retryDelayMs`) for a concurrent holder to release, reclaiming the lock
// early once its holder is judged gone, and gives up after `timeoutMs`.
export async function withMkdirLock<T>(
  lockDirPath: string,
  fn: () => Promise<T>,
  options: MkdirLockOptions = {},
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 50
  const timeoutMs = options.timeoutMs ?? 10_000
  const deadline = Date.now() + timeoutMs

  let owner = await tryAcquire(lockDirPath)
  while (owner === null) {
    await waitForHolder(lockDirPath, deadline, retryDelayMs)
    owner = await tryAcquire(lockDirPath)
  }

  try {
    return await fn()
  } finally {
    await release(lockDirPath, owner)
  }
}
