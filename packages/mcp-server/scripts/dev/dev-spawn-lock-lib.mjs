// Cross-process mutual exclusion for the probe-decide-spawn sequence in
// ensure-http-dev-daemon.mjs. Two SessionStart hooks starting close together
// (a new editor session plus a `new-worktree.mjs` run, say) both observe the
// derived port free and both spawn `pnpm mcp:http:dev`, producing an
// EADDRINUSE bind race whose loser's session gets zero MCP tools. The lock
// here makes that sequence atomic across processes. with-dev-data-dir.mjs
// takes the same lock for its own check-and-start, so a manual `pnpm dev`
// beside the hook's boot cannot start a second watcher either.
//
// All fs access is injectable so unit tests can exercise error paths and
// the "no existence-check before create" structural guarantee without
// touching the real filesystem.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'

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

function createLockFileExclusive(lockPath, content, { fsOpen, fsWrite, fsClose }) {
  const fd = fsOpen(lockPath, 'wx')
  try {
    fsWrite(fd, content)
  } finally {
    fsClose(fd)
  }
}

/**
 * Creates `path` holding `content` exclusively, replacing an existing file
 * only when `isHolderGone` says whoever wrote it is gone. Creation is a single
 * `open(path, 'wx')` — an existence check followed by a create would reopen
 * the exact race an exclusive file exists to close.
 *
 * On EEXIST, reads and stat's the existing file; if the holder is gone,
 * claims it via an atomic `rename()` of the stale file to a private
 * per-attempt path, then retries the exclusive create exactly once (a second
 * EEXIST means another process won the steal race — 'held' rather than
 * looping unbounded). The rename is the mutual-exclusion point for two racing
 * stealers: `rename()` only succeeds for the first caller — a second
 * `rename()` of the same source path fails with ENOENT once the first has
 * already moved it away — so at most one stealer ever proceeds to (re)create
 * the file. A bare `unlink()` here would NOT provide this guarantee: it
 * removes whatever currently sits at `path` unconditionally, so a second
 * stealer's unlink could silently delete a file a faster stealer had already
 * recreated, letting both believe they hold it. Any unexpected fs error
 * anywhere on this path also degrades to 'held', so a caller always has a
 * well-defined fallback instead of a thrown exception.
 *
 * `holderText` is the existing file's content as read, for a caller that
 * names the holder; it is null when no holder was read, or when the one read
 * is no longer the one in place (the steal was lost after the rename).
 *
 * @param {{ path: string, content: string, nowMs: number, isHolderGone: (holder: { text: string | null, mtimeMs: number }) => boolean, fsOpen: typeof openSync, fsWrite: (fd: number, data: string) => unknown, fsClose: typeof closeSync, fsReadFile: typeof readFileSync, fsStat: typeof statSync, fsUnlink: typeof unlinkSync, fsRename: typeof renameSync, fsLink: typeof linkSync }} args
 * @returns {{ kind: 'claimed' } | { kind: 'held', holderText: string | null }}
 */
function claimExclusiveFile({
  path,
  content,
  nowMs,
  isHolderGone,
  fsOpen,
  fsWrite,
  fsClose,
  fsReadFile,
  fsStat,
  fsUnlink,
  fsRename,
  fsLink,
}) {
  const create = () => createLockFileExclusive(path, content, { fsOpen, fsWrite, fsClose })
  try {
    create()
    return { kind: 'claimed' }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EEXIST') {
      return { kind: 'held', holderText: null }
    }
  }

  let text = null
  try {
    text = fsReadFile(path, 'utf8')
  } catch {
    /* Absent or unreadable — the caller's predicate decides what that means. */
  }

  let judged
  try {
    judged = fsStat(path)
  } catch {
    return { kind: 'held', holderText: text }
  }

  const mtimeMs = judged.mtimeMs
  if (!isHolderGone({ text, mtimeMs })) return { kind: 'held', holderText: text }

  const claimPath = `${path}.stale-${process.pid}-${nowMs}-${randomUUID()}`
  try {
    fsRename(path, claimPath)
  } catch {
    // Another stealer already won the atomic claim (or the file vanished
    // for some other reason) — nothing was moved, so there is nothing of
    // ours to clean up.
    return { kind: 'held', holderText: text }
  }

  // The rename moves whatever sits at `path` NOW. Another stealer may have
  // moved the judged file away and created its own in between, so the moved
  // file must still be the one judged: rename keeps the inode, a fresh create
  // gets a new one (mtime is checked too, but alone it is no identity — two
  // files can share a timestamp). If it is not, it goes back with link(),
  // which never overwrites.
  if (!isSameFile(claimPath, judged, fsStat)) {
    let moved = null
    try {
      moved = fsReadFile(claimPath, 'utf8')
      fsLink(claimPath, path)
    } catch {
      /* Absent, or a third file is in place already — that one holds. */
    }
    try {
      fsUnlink(claimPath)
    } catch {
      /* Best-effort cleanup of the private copy. */
    }
    return { kind: 'held', holderText: moved }
  }

  try {
    create()
    return { kind: 'claimed' }
  } catch {
    return { kind: 'held', holderText: null }
  } finally {
    try {
      fsUnlink(claimPath)
    } catch {
      /* Best-effort cleanup of the claimed stale file's private copy. */
    }
  }
}

function isSameFile(claimPath, judged, fsStat) {
  try {
    const moved = fsStat(claimPath)
    return moved.dev === judged.dev && moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs
  } catch {
    return false
  }
}

/**
 * Attempts to atomically acquire the spawn lock through `claimExclusiveFile`,
 * judging an existing lock with `isLockStale`. 'held-by-other' leaves a
 * SessionStart hook a well-defined fallback (wait for the daemon).
 *
 * @param {{ lockPath: string, meta: unknown, nowMs?: number, staleAfterMs: number, isPidAlive: (pid: number) => boolean, fsOpen?: typeof openSync, fsWrite?: (fd: number, data: string) => unknown, fsClose?: typeof closeSync, fsReadFile?: typeof readFileSync, fsStat?: typeof statSync, fsUnlink?: typeof unlinkSync, fsRename?: typeof renameSync, fsLink?: typeof linkSync }} args
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
  fsRename = renameSync,
  fsLink = linkSync,
}) {
  const result = claimExclusiveFile({
    path: lockPath,
    content: JSON.stringify(meta),
    nowMs,
    isHolderGone: ({ text, mtimeMs }) =>
      isLockStale({
        meta: parseLockMeta(text),
        lockMtimeMs: mtimeMs,
        nowMs,
        staleAfterMs,
        isPidAlive,
      }),
    fsOpen,
    fsWrite,
    fsClose,
    fsReadFile,
    fsStat,
    fsUnlink,
    fsRename,
    fsLink,
  })
  return result.kind === 'claimed' ? 'acquired' : 'held-by-other'
}

function parseLockMeta(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    /* Unparsable metadata — `isLockStale` falls through to the age check. */
    return null
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

/**
 * Claims the wrapper's pid file (`dev-wrapper.pid`, the pid `pnpm
 * mcp:http:stop` signals) through `claimExclusiveFile`, so a second wrapper
 * can never overwrite the first one's. A file whose writer is gone — a
 * wrapper killed outright leaves one behind — is replaced. `isWriterAlive`
 * decides with the file's mtime, so a caller can tell the wrapper that wrote
 * it from an unrelated process that has since taken its pid. An unreadable
 * file is held, while one naming no pid is replaced.
 *
 * @param {{ pidPath: string, pid: number, isWriterAlive: (pid: number, writtenAtMs: number) => boolean, fsOpen?: typeof openSync, fsWrite?: (fd: number, data: string) => unknown, fsClose?: typeof closeSync, fsReadFile?: typeof readFileSync, fsStat?: typeof statSync, fsUnlink?: typeof unlinkSync, fsRename?: typeof renameSync, fsLink?: typeof linkSync }} args
 * @returns {{ kind: 'claimed' } | { kind: 'held', pid: number | null }}
 */
export function claimPidFile({
  pidPath,
  pid,
  isWriterAlive,
  fsOpen = openSync,
  fsWrite = writeSync,
  fsClose = closeSync,
  fsReadFile = readFileSync,
  fsStat = statSync,
  fsUnlink = unlinkSync,
  fsRename = renameSync,
  fsLink = linkSync,
}) {
  const result = claimExclusiveFile({
    path: pidPath,
    content: String(pid),
    nowMs: Date.now(),
    isHolderGone: ({ text, mtimeMs }) => {
      if (text === null) return false
      const holder = parsePid(text)
      return holder === null || !isWriterAlive(holder, mtimeMs)
    },
    fsOpen,
    fsWrite,
    fsClose,
    fsReadFile,
    fsStat,
    fsUnlink,
    fsRename,
    fsLink,
  })
  if (result.kind === 'claimed') return result
  return { kind: 'held', pid: result.holderText === null ? null : parsePid(result.holderText) }
}

function parsePid(text) {
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Removes the pid file only while it still names `pid`, so a wrapper never
 * deletes the file another wrapper has since claimed. Never throws.
 *
 * @param {{ pidPath: string, pid: number, fsReadFile?: typeof readFileSync, fsUnlink?: typeof unlinkSync }} args
 */
export function releasePidFile({ pidPath, pid, fsReadFile = readFileSync, fsUnlink = unlinkSync }) {
  try {
    if (Number(fsReadFile(pidPath, 'utf8')) !== pid) return
    fsUnlink(pidPath)
  } catch {
    /* Absent or unremovable pid file is fine — nothing to do. */
  }
}
