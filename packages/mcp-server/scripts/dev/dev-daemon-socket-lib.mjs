// How development tools reach a dev daemon: through the record the daemon
// writes into its data dir (daemon.json), over the owner-only socket that
// record names (ADR-0050 decision 2). The socket path hashes the data dir,
// and each checkout has its own data dir, so a checkout can only ever reach
// its own daemon — no port to derive, and none for two worktrees to share.
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

/**
 * The record's `launch` for a daemon running a build (dist/) rather than
 * watch-mode source: `daemonRecordSchema`'s member, spelled here once.
 */
export const BUILT_LAUNCH = 'built'

/**
 * The daemon record in `dataDir`, or null while no daemon has written one — or
 * wrote one this script cannot use. Read on every use rather than once: a watch
 * restart rewrites it, and a stopped daemon deletes it.
 *
 * Only the fields these scripts cannot act without are checked: the socket to
 * talk to and the pid to stop. The rest are passed through as written —
 * `startedAt` to tell the daemon from a process that took its pid, `launch` to
 * tell a build from watch-mode source (absent: source). They mirror
 * `daemonRecordSchema` (src/daemon), which these scripts cannot import because
 * they run under bare `node` before any build; `dev-daemon-socket-lib.test.ts`
 * holds the two together. The record has no port: the daemon listens on no
 * port (ADR-0050).
 *
 * @param {string} dataDir
 * @returns {{ pid: number, socketPath: string, token?: string, version?: string, startedAt?: string, launch?: string } | null}
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
 * The `code` of `requestDaemon`'s rejection when the socket accepted the
 * connection and gave no answer within its timeout — something is serving
 * there — as against a connection refused or a socket that does not exist.
 */
export const NO_ANSWER = 'ERR_DAEMON_NO_ANSWER'

/**
 * One HTTP exchange with the daemon a record names. `socketPath` is a Unix
 * socket, or a named pipe on Windows — `http.request` takes either.
 *
 * @param {{ socketPath: string }} record
 * `onChunk` sees each body chunk as it arrives, with the status and content
 * type already known — what a caller relaying a stream that may never end
 * needs, since the promise settles only at the end. A 2xx event stream handed
 * to `onChunk` is not also kept: its caller has relayed it, and holding a
 * stream that never ends would grow for its whole life, so `text` is empty.
 *
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, timeoutMs?: number, onChunk?: (chunk: string, head: { status: number, contentType: string }) => void }} req
 * @returns {Promise<{ status: number, contentType: string, text: string }>}
 */
export function requestDaemon(
  record,
  { method = 'GET', path, headers = {}, body, timeoutMs, onChunk },
) {
  return new Promise((resolveRequest, rejectRequest) => {
    // Once the socket took the connection, anything going wrong after is a
    // daemon that did not answer, not a socket nobody listens on.
    let connected = false
    const fail = (error) =>
      rejectRequest(
        connected && error?.code !== NO_ANSWER
          ? Object.assign(new Error(error?.message ?? 'daemon did not answer'), {
              code: NO_ANSWER,
              cause: error,
            })
          : error,
      )
    const req = request({ socketPath: record.socketPath, path, method, headers }, (res) => {
      let text = ''
      const head = {
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? '').toLowerCase(),
      }
      const relayedStream =
        onChunk !== undefined &&
        head.status >= 200 &&
        head.status < 300 &&
        head.contentType.includes('text/event-stream')
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        if (!relayedStream) text += chunk
        onChunk?.(chunk, head)
      })
      res.on('end', () => resolveRequest({ ...head, text }))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.on('socket', (socket) => {
      if (!socket.connecting) connected = true
      else socket.once('connect', () => (connected = true))
    })
    if (timeoutMs !== undefined) {
      // A Unix socket or named pipe refuses a connection at once, or takes
      // it: running out of time means it was taken and then left unanswered.
      req.setTimeout(timeoutMs, () =>
        req.destroy(
          Object.assign(new Error(`no answer within ${timeoutMs}ms`), { code: NO_ANSWER }),
        ),
      )
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
function recordedProcess(
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
 * Whether `pid` is still the process that wrote a record at `writtenAt`:
 * `recordedProcess`'s answer for a caller whose record was written by
 * something other than the daemon (the dev wrapper's pid file), so its call
 * site does not have to read as "is this process the daemon".
 *
 * @param {number} pid
 * @param {string | undefined} writtenAt
 * @param {{ isAlive?: (pid: number) => boolean, startMs?: (pid: number) => number | null }} [seams]
 * @returns {boolean}
 */
export function isRecordWriter(pid, writtenAt, seams) {
  return recordedProcess(pid, writtenAt, seams) === 'daemon'
}

/**
 * Whether `pid` is still the process that wrote a pid file last modified at
 * `writtenAtMs`: the judgement `claimPidFile` is given for `dev-wrapper.pid`,
 * and the one every script deciding "is a dev wrapper running" uses.
 *
 * @param {number} pid
 * @param {number} writtenAtMs
 * @param {{ isAlive?: (pid: number) => boolean, startMs?: (pid: number) => number | null }} [seams]
 * @returns {boolean}
 */
export function isPidFileWriter(pid, writtenAtMs, seams) {
  return isRecordWriter(pid, new Date(writtenAtMs).toISOString(), seams)
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

/**
 * Long enough for a daemon busy on a large write to answer, short enough that
 * a stop run against a socket nobody serves does not appear to hang — the
 * daemon's own `daemonLiveness` waits as long.
 */
const STATUS_ASK_TIMEOUT_MS = 1_500

/**
 * Whether the daemon a record names is running, by the daemon's own rule
 * (`daemonLiveness`, src/daemon/daemon-liveness.ts), restated for bare `node`;
 * `dev-daemon-socket-lib.test.ts` holds the two to the same answers.
 *
 * The pid's start time decides on the plain path. When it says the pid started
 * after the record, the record's socket is asked before that is believed: a
 * forward step of the wall clock moves `/proc/stat`'s btime but not a
 * process's start ticks, so a live daemon then reads as having started after
 * its own record. Its runtime status, asked under the record's token, names its
 * pid; naming the recorded one makes it the writer. Only the `pid` of that
 * answer is read — the rest of `runtimeStatusResponseSchema` is not something
 * this script can import, and an answer under the record's token naming the
 * recorded pid is the daemon whatever else it says.
 *
 * - `running`: the pid is the process that wrote the record.
 * - `unconfirmed`: the start time says otherwise, and something serves the
 *   record's socket without confirming the pid — an answer naming another pid,
 *   or a connection taken and left unanswered, as a daemon wedged on its loop
 *   does. Nothing may signal it, and its record is not a leftover.
 * - `pid-reused`: the pid started after the record and the socket refuses the
 *   connection, or is not there.
 * - `dead`: no process has the pid.
 *
 * @param {{ pid: number, socketPath?: string, startedAt?: string, token?: string }} record
 * @param {{
 *   isAlive?: (pid: number) => boolean,
 *   startMs?: (pid: number) => number | null,
 *   request?: typeof requestDaemon,
 * }} [seams]
 * @returns {Promise<'running' | 'unconfirmed' | 'pid-reused' | 'dead'>}
 */
export async function recordedDaemonLiveness(
  record,
  { isAlive = isPidAlive, startMs = readProcessStartMs, request = requestDaemon } = {},
) {
  const identity = recordedProcess(record.pid, record.startedAt, { isAlive, startMs })
  if (identity === 'daemon') return 'running'
  if (identity === 'dead') return 'dead'
  const { socketPath } = record
  if (socketPath === undefined) return 'pid-reused'
  let answer
  try {
    answer = await request(
      { socketPath },
      {
        path: '/api/runtime/status',
        headers: {
          ...(record.token === undefined ? {} : { authorization: `Bearer ${record.token}` }),
          accept: 'application/json',
        },
        timeoutMs: STATUS_ASK_TIMEOUT_MS,
      },
    )
  } catch (error) {
    return error?.code === NO_ANSWER ? 'unconfirmed' : 'pid-reused'
  }
  return answer.status === 200 && statusPid(answer.text) === record.pid ? 'running' : 'unconfirmed'
}

/**
 * The `pid` a runtime status body names, or null when it names none.
 * @param {string} text
 * @returns {number | null}
 */
function statusPid(text) {
  try {
    const body = JSON.parse(text)
    return body !== null && typeof body === 'object' && typeof body.pid === 'number'
      ? body.pid
      : null
  } catch {
    return null
  }
}
