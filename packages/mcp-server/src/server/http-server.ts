import { randomUUID } from 'node:crypto'
import { accessSync, existsSync, constants as fsConstants } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { IdleTimer } from '../daemon/idle-timer.js'
import type { RuntimeStatusResponse } from '../shared/api-contracts/runtime.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { WHITEBOARD_WS_PROTOCOL } from '../shared/ws-protocol.js'
import { createApp } from './app.js'
import { DATA_DIR, DIST_WEB_APP_DIR } from './config.js'
import { normalizeBindHost } from './daemon-auth-binding.js'
import { getConnectionStats, handleWsUpgrade, setRuntimeTouchFn } from './routes/ws.js'
import { authorizeWsUpgrade } from './routes/ws-auth.js'
import { parseWsTargetFromRequestUrl } from './routes/ws-validation.js'
import type { McpHttpAuthStrategy } from './security/mcp-auth.js'
import { validationErrorBody } from './validators.js'

export type RuntimeStatus = RuntimeStatusResponse

export interface StartHttpServerOptions {
  port: number
  host?: string
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  idleTimeoutMs?: number
  onClose?: () => Promise<void> | void
  /** Exact-match hosted origins admitted alongside loopback, on /api CORS,
   *  /mcp, and WS upgrade (WHITEBOARD_ALLOWED_WEB_ORIGINS). Empty by default. */
  allowedWebOrigins?: readonly string[]
}

export interface RunningServer {
  port: number
  /** Unique per process-start id; used by CLI stop/status/doctor to verify
   *  they are talking to the daemon they recorded, not a PID-reuse impostor. */
  instanceId: string
  close: () => Promise<void>
  touch: () => void
  getRuntimeStatus: () => RuntimeStatus
}

type ClosableHttpServer = ReturnType<typeof serve> & {
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningServer> {
  const host = normalizeBindHost(options.host ?? '127.0.0.1')
  const instanceId = randomUUID()
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  let server: ReturnType<typeof serve>
  let wss: WebSocketServer
  let closing = false
  const sockets = new Set<Socket>()

  const idleTimer = new IdleTimer(options.idleTimeoutMs ?? 15 * 60_000, () => {
    void close()
  })

  const touch = () => idleTimer.touch()
  const getRuntimeStatus = (): RuntimeStatusResponse => {
    const stats = getConnectionStats()
    return {
      ok: true,
      pid: process.pid,
      host,
      port: options.port,
      baseUrl: `http://${host}:${options.port}`,
      version: PACKAGE_VERSION,
      startedAt,
      uptimeMs: Date.now() - startedAtMs,
      idleForMs: idleTimer.getIdleForMs(),
      auth: { mode: 'local-token', hasToken: Boolean(options.token) },
      storage: {
        dataDir: DATA_DIR,
        dataDirWritable: (() => {
          try {
            accessSync(DATA_DIR, fsConstants.W_OK)
            return true
          } catch {
            return false
          }
        })(),
      },
      app: {
        served: true,
        buildPresent: existsSync(join(DIST_WEB_APP_DIR, 'index.html')),
        ui: 'web-app',
      },
      mcp: { httpEnabled: true, endpoint: `http://${host}:${options.port}/mcp` },
      clients: { connected: stats.connectedClients, ready: stats.readyClients },
    }
  }

  const close = async () => {
    if (closing) return
    closing = true
    idleTimer.stop()
    setRuntimeTouchFn(() => {})

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
      const closeableServer = server as ClosableHttpServer
      // Idle shutdown must not leave keep-alive HTTP sockets behind, otherwise the
      // process can linger in a half-closed state where WS upgrades return 503.
      closeableServer.closeIdleConnections?.()
      closeableServer.closeAllConnections?.()
      for (const socket of sockets) {
        socket.destroy()
      }
    })

    for (const client of wss.clients) {
      client.terminate()
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))

    await options.onClose?.()
  }

  const app = createApp({
    authMode: 'local-daemon',
    token: options.token,
    mcpAuth: options.mcpAuth,
    instanceId,
    touch,
    getStatus: getRuntimeStatus,
    shutdown: close,
    allowedWebOrigins: options.allowedWebOrigins,
  })

  setRuntimeTouchFn(touch)
  idleTimer.start()

  server = serve({ fetch: app.fetch, port: options.port, hostname: host })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })
  wss = new WebSocketServer({
    noServer: true,
    // Per-frame limit. Keep enough room for Loro snapshots and large image imports
    // (8 MiB) while avoiding OOM if a malicious client sends the ws default 100 MiB.
    // When exceeded, ws closes the connection automatically with 1009 (Message Too Big).
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: (protocols) =>
      protocols.has(WHITEBOARD_WS_PROTOCOL) ? WHITEBOARD_WS_PROTOCOL : false,
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy()
      return
    }
    const decision = authorizeWsUpgrade(req.headers, options.token, options.allowedWebOrigins)
    if (!decision.accept) {
      const statusCode = decision.statusCode ?? 401
      const statusText = statusCode === 403 ? 'Forbidden' : 'Unauthorized'
      socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    try {
      parseWsTargetFromRequestUrl(req.url, req.headers.host ?? 'localhost')
    } catch (error) {
      const issue = validationErrorBody(error)
      const body = issue ? JSON.stringify(issue) : ''
      socket.write(
        `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
      socket.destroy()
      return
    }
    touch()
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleWsUpgrade(req, ws, decision.scopes)
    })
  })

  return {
    port: options.port,
    instanceId,
    close,
    touch,
    getRuntimeStatus,
  }
}
