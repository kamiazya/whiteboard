// Whether a pid is still the process that wrote a record naming it.
//
// A record (daemon.json, a lock's owner) outlives a writer that died without
// removing it, and after a crash or a reboot its pid can belong to any other
// process of the same user. Signal 0 cannot tell those apart; the process's
// start time can, because a writer started before it wrote. Where the start
// time is unknowable (no /proc: macOS, Windows) the answer is `unknown`, never
// `foreign`, so a live writer is never called foreign — the safe direction for
// a caller that refuses something while the writer runs. It is not `writer`
// either: a caller about to hand that process a secret has to learn the pid
// proved nothing, and ask the process itself.
//
// `scripts/dev/dev-daemon-socket-lib.mjs` keeps a bare-node copy of this
// judgement; its test holds the two to the same answers.

import { readFileSync } from 'node:fs'
import { isPidAlive } from './process-alive.js'

// /proc reports a start time in USER_HZ ticks, which the kernel fixes at 100
// for userspace on every architecture.
const USER_HZ = 100

/**
 * A writer's record is written after its process started, so its process can
 * never have started after the record. The slack absorbs `btime`'s
 * whole-second resolution and a small clock step since boot.
 */
const START_SLACK_MS = 5_000

export interface ProcessIdentitySeams {
  readonly isAlive?: (pid: number) => boolean
  readonly startMs?: (pid: number) => number | null
}

/**
 * When the process with this pid started, in ms since the epoch, or null where
 * this platform cannot say. Linux answers from `/proc/<pid>/stat` (field 22,
 * ticks after boot) and `/proc/stat`'s `btime`.
 */
export function readProcessStartMs(
  pid: number,
  { readFile = (path: string) => readFileSync(path, 'utf8') } = {},
): number | null {
  try {
    const stat = readFile(`/proc/${pid}/stat`)
    // The command name is parenthesised and may itself hold spaces and
    // parentheses, so fields are counted from the LAST `)`: field 3 follows it.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(fields[22 - 3])
    const btime = /^btime (\d+)$/m.exec(readFile('/proc/stat'))
    if (!Number.isFinite(startTicks) || btime === null) return null
    return Number(btime[1]) * 1000 + (startTicks * 1000) / USER_HZ
  } catch {
    return null
  }
}

/**
 * What the pid a record written at `writtenAtMs` names is now: gone, a process
 * that started after the record (it took over the pid of a writer that died),
 * the writer, or — where this platform cannot read the process's start time —
 * `unknown`, a live pid that may be either. A record with no time of its own
 * (NaN) reads as the writer: the start time it would be compared with exists.
 */
export function recordedProcess(
  pid: number,
  writtenAtMs: number,
  { isAlive = isPidAlive, startMs = readProcessStartMs }: ProcessIdentitySeams = {},
): 'writer' | 'unknown' | 'foreign' | 'dead' {
  if (!isAlive(pid)) return 'dead'
  const started = startMs(pid)
  if (started === null) return 'unknown'
  if (Number.isNaN(writtenAtMs)) return 'writer'
  return started <= writtenAtMs + START_SLACK_MS ? 'writer' : 'foreign'
}
