// How development tools reach a dev daemon: through the record the daemon
// writes into its data dir (daemon.json), over the owner-only socket that
// record names (ADR-0050 decision 2). The socket path hashes the data dir,
// and each checkout has its own data dir, so a checkout can only ever reach
// its own daemon — no port to derive, and none for two worktrees to share.
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

/**
 * The daemon record in `dataDir`, or null while no daemon has written one — or
 * wrote one this script cannot use. Read on every use rather than once: a watch
 * restart rewrites it, and a stopped daemon deletes it.
 *
 * Only the fields these scripts act on are checked: the socket to talk to and
 * the pid to stop. They mirror `daemonRecordSchema` (src/daemon), which these
 * scripts cannot import because they run under bare `node` before any build;
 * `dev-daemon-socket-lib.test.ts` holds the two together. The record has no
 * port: the daemon listens on no port (ADR-0050).
 *
 * @param {string} dataDir
 * @returns {{ pid: number, socketPath: string, token?: string, startedAt?: string } | null}
 */
export function readDaemonRecord(dataDir) {
  try {
    const record = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
    if (record === null || typeof record !== 'object') return null
    if (!Number.isInteger(record.pid) || record.pid <= 0) return null
    if (typeof record.socketPath !== 'string' || record.socketPath === '') return null
    return record
  } catch {
    return null
  }
}

/**
 * Whether a process with this pid exists — the bare-`node` mirror of
 * `isPidAlive` (src/shared/process-alive.ts), which the daemon's own refusal to
 * start beside a live record uses; `dev-daemon-socket-lib.test.ts` holds the
 * two to the same answers. `EPERM` reads as alive: the process exists, it is
 * just not ours to signal, and calling a live daemon dead is the unsafe side.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * One HTTP exchange with the daemon a record names. `socketPath` is a Unix
 * socket, or a named pipe on Windows — `http.request` takes either.
 *
 * @param {{ socketPath: string }} record
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} req
 * @returns {Promise<{ status: number, contentType: string, text: string }>}
 */
export function requestDaemon(record, { method = 'GET', path, headers = {}, body, timeoutMs }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request({ socketPath: record.socketPath, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () =>
        resolveRequest({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? '').toLowerCase(),
          text,
        }),
      )
      res.on('error', rejectRequest)
    })
    req.on('error', rejectRequest)
    if (timeoutMs !== undefined) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs}ms`)))
    }
    req.end(body)
  })
}

/** How long a ping waits before the daemon reads as not answering. */
export const PING_TIMEOUT_MS = 3_000

/**
 * Whether the daemon a record names answers its unauthenticated liveness ping.
 *
 * @param {{ socketPath: string }} record
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function answersPing(record, timeoutMs = PING_TIMEOUT_MS) {
  try {
    const { status } = await requestDaemon(record, { path: '/api/runtime/ping', timeoutMs })
    return status === 200
  } catch {
    return false
  }
}

// /proc reports a start time in USER_HZ ticks, which the kernel fixes at 100
// for userspace on every architecture this repository is developed on.
const USER_HZ = 100

/**
 * When the process with this pid started, in ms since the epoch, or null where
 * this platform cannot say. Linux answers from `/proc/<pid>/stat` (field 22,
 * ticks after boot) and `/proc/stat`'s `btime`; elsewhere there is no `/proc`,
 * and null makes every caller fall back to the pid alone.
 *
 * @param {number} pid
 * @param {{ readFile?: (path: string) => string }} [seams]
 * @returns {number | null}
 */
export function readProcessStartMs(pid, { readFile = (path) => readFileSync(path, 'utf8') } = {}) {
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

// A daemon writes its record after it has started, so its process can never
// have started after `startedAt`. The slack absorbs `btime`'s whole-second
// resolution and a small clock step since boot; a process that took over the
// pid would have to start within it of the daemon's own start and death.
const START_SLACK_MS = 5_000

/**
 * What the pid a record names is: gone, a process that started after the
 * record was written (so it took over the pid of a daemon that died without
 * deleting its record), or — as far as this platform can tell — the process
 * that wrote it. Missing start times on either side read as the daemon:
 * calling a live daemon foreign would start a second one beside it.
 *
 * @param {number} pid
 * @param {string | undefined} startedAt
 * @param {{ isAlive?: (pid: number) => boolean, startMs?: (pid: number) => number | null }} [seams]
 * @returns {'daemon' | 'foreign' | 'dead'}
 */
export function recordedProcess(
  pid,
  startedAt,
  { isAlive = isPidAlive, startMs = readProcessStartMs } = {},
) {
  if (!isAlive(pid)) return 'dead'
  const recordedAt = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN
  const started = startMs(pid)
  if (Number.isNaN(recordedAt) || started === null) return 'daemon'
  return started <= recordedAt + START_SLACK_MS ? 'daemon' : 'foreign'
}

/**
 * The one answer to "is this checkout's daemon running", shared by the
 * wrapper's refusal to start a second one, `pnpm mcp:http:stop` and the
 * SessionStart hook: its socket answers, or the pid its record names is alive
 * AND is the process that wrote the record. A daemon too busy to answer the
 * ping is therefore still running — no second daemon, no stop — while a pid
 * reused by an unrelated process after a crash or a reboot is not.
 *
 * @param {{ pid: number, socketPath: string, startedAt?: string }} record
 * @param {{
 *   answers?: (record: { socketPath: string }) => Promise<boolean>,
 *   isAlive?: (pid: number) => boolean,
 *   startMs?: (pid: number) => number | null,
 * }} [seams]
 * @returns {Promise<{ running: boolean, answering: boolean, process: 'daemon' | 'foreign' | 'dead' }>}
 */
export async function assessRecordedDaemon(
  record,
  { answers = answersPing, isAlive = isPidAlive, startMs = readProcessStartMs } = {},
) {
  const identity = recordedProcess(record.pid, record.startedAt, { isAlive, startMs })
  const answering = await answers(record)
  return { running: answering || identity === 'daemon', answering, process: identity }
}
