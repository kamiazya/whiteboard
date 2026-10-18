import { chmodSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import {
  type RuntimeStatusResponse,
  runtimeStatusResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { onTestFinished } from 'vitest'
import { testSocketPath } from '../shared/test-utils/socket-fetch.js'

/**
 * A real listener on a fresh socket that answers the daemon's runtime status
 * as a daemon with `pid` would, admitting only `token`. Closed when the
 * calling test finishes, so it must be called from inside a test. `body`
 * replaces that status with an answer outside the contract.
 */
export async function answeringDaemonSocket(
  pid: number,
  token: string,
  { body }: { body?: unknown } = {},
): Promise<{ socketPath: string; asked: string[] }> {
  const socketPath = testSocketPath()
  const asked: string[] = []
  const status: RuntimeStatusResponse = runtimeStatusResponseSchema.parse({
    ok: true,
    pid,
    socketPath,
    version: '0.0.0',
    startedAt: new Date(0).toISOString(),
    uptimeMs: 0,
    idleForMs: 0,
    auth: { mode: 'local-daemon', hasToken: true },
    storage: { dataDir: '/data', dataDirWritable: true },
    mcp: { httpEnabled: true },
    clients: { connected: 0, ready: 0 },
  })
  const server = createServer((req, res) => {
    asked.push(req.url ?? '')
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
      return
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(body === undefined ? status : body))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return { socketPath, asked }
}

/**
 * A listener in a directory of mode `dirMode` that answers every request with
 * `body` under any credential, and keeps each Authorization header it was
 * sent — what a socket another user prepared at a recorded path would collect.
 */
export async function collectingDaemonSocket(dirMode: number, body: unknown) {
  const socketPath = testSocketPath()
  chmodSync(dirname(socketPath), dirMode)
  const authorizations: (string | undefined)[] = []
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  )
  return { socketPath, authorizations }
}
