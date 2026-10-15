import { createServer } from 'node:http'
import {
  type RuntimeStatusResponse,
  runtimeStatusResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { onTestFinished } from 'vitest'
import { testSocketPath } from '../shared/test-utils/socket-fetch.js'

/**
 * A real listener on a fresh socket that answers the daemon's runtime status
 * as a daemon with `pid` would, admitting only `token`. Closed when the
 * calling test finishes, so it must be called from inside a test.
 */
export async function answeringDaemonSocket(
  pid: number,
  token: string,
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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status))
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
