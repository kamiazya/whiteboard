import { serve } from '@hono/node-server'
import type { Socket } from 'node:net'
import { WebSocketServer } from 'ws'
import { IdleTimer } from '../daemon/idle-timer.js'
import { definedProps } from './defined-props.js'
import { createApp } from './app.js'
import { handleWsUpgrade, getConnectionStats, setRuntimeTouchFn } from './routes/ws.js'
import { WHITEBOARD_WS_PROTOCOL } from '../shared/ws-protocol.js'
import { authorizeWsUpgrade } from './routes/ws-auth.js'
import { validationErrorBody } from './validators.js'
import { parseWsTargetFromRequestUrl } from './routes/ws-validation.js'
import type { McpHttpAuthStrategy } from './security/mcp-auth.js'

export interface RuntimeStatus {
  pid: number
  port: number
  startedAt: string
  uptimeMs: number
  idleForMs: number
  connectedClients: number
  readyClients: number
}

export interface StartHttpServerOptions {
  port: number
  host?: string
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  idleTimeoutMs?: number
  onClose?: () => Promise<void> | void
}

export interface RunningServer {
  port: number
  close: () => Promise<void>
  touch: () => void
  getRuntimeStatus: () => RuntimeStatus
}

type ClosableHttpServer = ReturnType<typeof serve> & {
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'
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
  const getRuntimeStatus = (): RuntimeStatus => {
    const stats = getConnectionStats()
    return {
      pid: process.pid,
      port: options.port,
      startedAt,
      uptimeMs: Date.now() - startedAtMs,
      idleForMs: idleTimer.getIdleForMs(),
      connectedClients: stats.connectedClients,
      readyClients: stats.readyClients,
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
    touch,
    getStatus: getRuntimeStatus,
    shutdown: close,
    ...definedProps({
      token: options.token,
      mcpAuth: options.mcpAuth,
    }),
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
    const decision = authorizeWsUpgrade(req.headers, options.token)
    if (!decision.accept) {
      const statusCode = decision.statusCode ?? 401
      const statusText =
        statusCode === 403 ? 'Forbidden' : 'Unauthorized'
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
      void handleWsUpgrade(req, ws)
    })
  })

  return {
    port: options.port,
    close,
    touch,
    getRuntimeStatus,
  }
}
