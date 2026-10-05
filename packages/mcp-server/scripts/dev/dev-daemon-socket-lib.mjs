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
 * @returns {{ pid: number, socketPath: string, token?: string } | null}
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
