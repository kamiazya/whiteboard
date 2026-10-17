// When a cross-process lock's holder is gone, judged once for every lock the
// server takes (`daemon.lock`, `migration.lock`). Each lock keeps its own file
// protocol; what counts as stale is decided here.

import { hostname } from 'node:os'
import { type ProcessIdentitySeams, recordedProcess } from './process-identity.js'

/**
 * A lock is created and then written, in two calls, so a racing opener can
 * find it unwritten. Past this, an unwritten lock was left by a holder that
 * died between the two.
 */
export const UNWRITTEN_LOCK_GRACE_MS = 5_000

/**
 * The host a lock holder ran on. A pid means something only in the pid
 * namespace that issued it: containers sharing one data volume each see their
 * own pids (and each runs as pid 1), so a holder on another host is never
 * judged by its pid. A container's hostname differs from its siblings' by
 * default.
 */
export function lockHolderHost(): string {
  return hostname()
}

export interface LockHolder {
  /** Null when the lock names no usable pid. */
  readonly pid: number | null
  /** Absent in a lock written before holders recorded it: judged by pid. */
  readonly host?: string
}

export type HolderJudgement =
  | { readonly kind: 'held'; readonly holderPid: number | null; readonly host?: string }
  | { readonly kind: 'gone'; readonly holderPid: number | null; readonly reason: string }

export interface JudgeSeams extends ProcessIdentitySeams {
  readonly nowMs?: number
  readonly host?: string
}

/**
 * Whether a lock's holder still holds it. `writtenAtMs` is when the holder
 * wrote the lock (or created it, for an unwritten one): a holder's process
 * started before that, so a live pid that started after it is a reuse.
 */
export function judgeLockHolder(
  holder: LockHolder | 'unwritten',
  writtenAtMs: number,
  seams: JudgeSeams = {},
): HolderJudgement {
  if (holder === 'unwritten') {
    return (seams.nowMs ?? Date.now()) - writtenAtMs > UNWRITTEN_LOCK_GRACE_MS
      ? { kind: 'gone', holderPid: null, reason: 'lock never written' }
      : { kind: 'held', holderPid: null }
  }
  const { pid, host } = holder
  if (pid === null || !Number.isInteger(pid) || pid <= 0) {
    return { kind: 'gone', holderPid: null, reason: 'lock names no pid' }
  }
  if (host !== undefined && host !== (seams.host ?? lockHolderHost())) {
    return { kind: 'held', holderPid: pid, host }
  }
  switch (recordedProcess(pid, writtenAtMs, seams)) {
    case 'dead':
      return { kind: 'gone', holderPid: pid, reason: 'holder exited' }
    case 'foreign':
      return { kind: 'gone', holderPid: pid, reason: 'holder pid reused by a later process' }
    // A lock is only waited on, never handed a secret, so a live pid this
    // platform cannot judge is still its holder.
    case 'writer':
    case 'unknown':
      return { kind: 'held', holderPid: pid }
  }
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
}

/**
 * Whether a lock file moved aside is still the one that was judged. A fresh
 * create can take the judged file's inode at once (ext4 reuses one
 * immediately), so dev and inode alone do not tell a successor's lock from
 * the stale one; its mtime does.
 */
export function sameLockFile(moved: FileIdentity, judged: FileIdentity): boolean {
  return moved.dev === judged.dev && moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs
}

/** A holder description for a message: its pid, and its host when not this one. */
export function describeHolder(holder: { holderPid: number | null; host?: string }): string {
  const pid = `process ${holder.holderPid ?? '(unknown)'}`
  return holder.host === undefined ? pid : `${pid} on host ${holder.host}`
}
