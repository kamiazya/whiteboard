// Cross-process mutual exclusion for the probe-decide-spawn sequence in
// ensure-http-dev-daemon.mjs. Two SessionStart hooks starting close together
// (a new editor session plus a `new-worktree.mjs` run, say) both observe the
// derived port free and both spawn `pnpm mcp:http:dev`, producing an
// EADDRINUSE bind race whose loser's session gets zero MCP tools. The lock
// here makes that sequence atomic across processes.
//
// All fs access is injectable so unit tests can exercise error paths and
// the "no existence-check before create" structural guarantee without
// touching the real filesystem.

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'

// Must exceed ensure-http-dev-daemon-lib.mjs's DEFAULT_READY_TIMEOUT_MS
// (30s) with margin, so a legitimately slow cold start (tsx + happy-dom +
// canvas + resvg, ~10-15s on slow machines, on top of the winner's own
// ready-wait) is never mistaken for a crashed lock holder and stolen out
// from under it.
export const DEFAULT_SPAWN_LOCK_STALE_MS = 45_000

/**
 * Resolves the stale-lock window from WHITEBOARD_DEV_SPAWN_LOCK_STALE_MS,
 * falling back to DEFAULT_SPAWN_LOCK_STALE_MS whenever the override is
 * absent or malformed (non-numeric, non-integer, zero, or negative). Total
 * and never throws, matching resolveReadyTimeoutMs's contract.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolveSpawnLockStaleMs(env) {
  const parsed = Number(env.WHITEBOARD_DEV_SPAWN_LOCK_STALE_MS)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SPAWN_LOCK_STALE_MS
  return parsed
}

/**
 * Pure staleness predicate. A lock is stale when the pid recorded in its
 * metadata is no longer alive (regardless of age — a dead holder can never
 * release it), OR when the lock's age exceeds `staleAfterMs` (covers a
 * crash between `open('wx')` and the metadata write, which leaves an
 * unparsable/empty file with no pid to check).
 *
 * @param {{ meta: { pid?: number } | null, lockMtimeMs: number, nowMs: number, staleAfterMs: number, isPidAlive: (pid: number) => boolean }} args
 * @returns {boolean}
 */
export function isLockStale({ meta, lockMtimeMs, nowMs, staleAfterMs, isPidAlive }) {
  const pid = meta?.pid
  if (typeof pid === 'number' && Number.isFinite(pid) && !isPidAlive(pid)) {
    return true
  }
  return nowMs - lockMtimeMs > staleAfterMs
}

function createLockFileExclusive(lockPath, content, fsOpen, fsWrite, fsClose) {
  const fd = fsOpen(lockPath, 'wx')
  try {
    fsWrite(fd, content)
  } finally {
    fsClose(fd)
  }
}

/**
 * Attempts to atomically acquire the spawn lock. Acquisition is a single
 * `open(lockPath, 'wx')` — an existence check followed by a create would
 * reopen the exact race this lock exists to close.
 *
 * On EEXIST, reads and stat's the existing lock; if `isLockStale` says the
 * holder is gone, unlinks it and retries the exclusive create exactly once
 * (a second EEXIST means another process won the steal race — returns
 * 'held-by-other' rather than looping unbounded). Any unexpected fs error
 * anywhere on this path also degrades to 'held-by-other', so a caller
 * always has a well-defined fallback (wait for the daemon) instead of a
 * thrown exception killing a SessionStart hook.
 *
 * @param {{ lockPath: string, meta: unknown, nowMs?: number, staleAfterMs: number, isPidAlive: (pid: number) => boolean, fsOpen?: typeof openSync, fsWrite?: typeof writeSync, fsClose?: typeof closeSync, fsReadFile?: typeof readFileSync, fsStat?: typeof statSync, fsUnlink?: typeof unlinkSync }} args
 * @returns {'acquired' | 'held-by-other'}
 */
export function acquireSpawnLock({
  lockPath,
  meta,
  nowMs = Date.now(),
  staleAfterMs,
  isPidAlive,
  fsOpen = openSync,
  fsWrite = writeSync,
  fsClose = closeSync,
  fsReadFile = readFileSync,
  fsStat = statSync,
  fsUnlink = unlinkSync,
}) {
  const content = JSON.stringify(meta)

  try {
    createLockFileExclusive(lockPath, content, fsOpen, fsWrite, fsClose)
    return 'acquired'
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EEXIST') {
      return 'held-by-other'
    }
  }

  let existingMeta = null
  try {
    existingMeta = JSON.parse(fsReadFile(lockPath, 'utf8'))
  } catch {
    existingMeta = null
  }

  let lockMtimeMs
  try {
    lockMtimeMs = fsStat(lockPath).mtimeMs
  } catch {
    return 'held-by-other'
  }

  const stale = isLockStale({ meta: existingMeta, lockMtimeMs, nowMs, staleAfterMs, isPidAlive })
  if (!stale) return 'held-by-other'

  try {
    fsUnlink(lockPath)
  } catch {
    return 'held-by-other'
  }

  try {
    createLockFileExclusive(lockPath, content, fsOpen, fsWrite, fsClose)
    return 'acquired'
  } catch {
    return 'held-by-other'
  }
}

/**
 * Best-effort lock release. Only unlinks the lock when it still records our
 * own pid, so a process whose lock was stolen (by the staleness path above)
 * can never delete its successor's lock. Never throws — correctness of the
 * overall scheme never depends on release succeeding; the staleness window
 * in `acquireSpawnLock` is the backstop.
 *
 * @param {{ lockPath: string, ownerPid: number, fsReadFile?: typeof readFileSync, fsUnlink?: typeof unlinkSync }} args
 */
export function releaseSpawnLock({
  lockPath,
  ownerPid,
  fsReadFile = readFileSync,
  fsUnlink = unlinkSync,
}) {
  try {
    const meta = JSON.parse(fsReadFile(lockPath, 'utf8'))
    if (meta?.pid !== ownerPid) return
    fsUnlink(lockPath)
  } catch {
    /* Absent, unparsable, or unremovable lock is fine — nothing to do. */
  }
}
