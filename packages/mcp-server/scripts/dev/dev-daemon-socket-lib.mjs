// How development tools reach a dev daemon: through the record the daemon
// writes into its data dir (daemon.json), over the owner-only socket that
// record names (ADR-0050 decision 2). The socket path hashes the data dir,
// and each checkout has its own data dir, so a checkout can only ever reach
// its own daemon — no port to derive, and none for two worktrees to share.
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

/**
 * The daemon record in `dataDir`, or null while no daemon has written one.
 * Read on every use rather than once: a watch restart rewrites it, and a
 * stopped daemon deletes it.
 *
 * @param {string} dataDir
 * @returns {{ socketPath?: string, port?: number, token?: string, pid?: number } | null}
 */
export function readDaemonRecord(dataDir) {
  try {
    const record = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
    return record !== null && typeof record === 'object' ? record : null
  } catch {
    return null
  }
}

function targetOf(record) {
  if (typeof record.socketPath === 'string' && record.socketPath !== '') {
    return { socketPath: record.socketPath }
  }
  return null
}

/**
 * One HTTP exchange with the daemon a record names. `socketPath` is a Unix
 * socket, or a named pipe on Windows — `http.request` takes either.
 *
 * @param {{ socketPath?: string }} record
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} req
 * @returns {Promise<{ status: number, contentType: string, text: string }>}
 */
export function requestDaemon(record, { method = 'GET', path, headers = {}, body, timeoutMs }) {
  const target = targetOf(record)
  if (target === null) return Promise.reject(new Error('the daemon record names no socket'))
  return new Promise((resolveRequest, rejectRequest) => {
    const req = request({ ...target, path, method, headers }, (res) => {
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
