// HTTP server startup for server-mode (OAuth/JWT, no local-daemon lifecycle).
//
// Server-mode does not use WebSocket, idle timeout, or per-connection
// tracking in this initial slice — those are local-daemon concerns.
// The close() returned by startServerModeHttp tears down the HTTP server
// cleanly so the dispatcher's SIGTERM handler can await it.

import { randomUUID } from 'node:crypto'
import { accessSync, existsSync, constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { DATA_DIR, DIST_APP_DIR } from './config.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'

export interface StartServerModeHttpOptions {
  host: string
  port: number
  publicBaseUrl: string
  allowedOrigins: readonly string[]
  authStrategy: AsyncAuthStrategy
}

export interface ServerModeRunning {
  port: number
  host: string
  startedAt: string
  resolvedDataDir: string
  /** Unique per process-start id; written into the server-mode record so
   *  stop/status/doctor can verify identity instead of trusting a reused pid. */
  instanceId: string
  close: () => Promise<void>
}

function isDataDirWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function startServerModeHttp(
  options: StartServerModeHttpOptions,
): Promise<ServerModeRunning> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const instanceId = randomUUID()
  const baseUrl = `https://${options.host}:${options.port}`
  let closing = false

  const close = async () => {
    if (closing) return
    closing = true
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  const app = createApp({
    authMode: 'server-mode',
    publicBaseUrl: options.publicBaseUrl,
    allowedOrigins: options.allowedOrigins,
    authStrategy: options.authStrategy,
    instanceId,
    touch: () => {},
    getStatus: () => ({
      ok: true,
      pid: process.pid,
      host: options.host,
      port: options.port,
      baseUrl,
      version: PACKAGE_VERSION,
      startedAt,
      uptimeMs: Date.now() - startedAtMs,
      idleForMs: 0,
      auth: { mode: 'oauth', hasToken: false },
      storage: {
        dataDir: DATA_DIR,
        dataDirWritable: isDataDirWritable(DATA_DIR),
      },
      app: {
        served: false,
        buildPresent: existsSync(join(DIST_APP_DIR, 'index.html')),
        // Server-mode's UI root is pinned to the legacy dist/app build until
        // R5 of the MCP-UI retirement (ADR 0001); it never serves dist/web-app.
        ui: 'legacy',
      },
      mcp: { httpEnabled: true, endpoint: `${baseUrl}/mcp` },
      clients: { connected: 0, ready: 0 },
      publicBaseUrl: options.publicBaseUrl,
    }),
    shutdown: close,
  })

  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host })

  await new Promise<void>((resolve, reject) => {
    if ((server as unknown as { listening: boolean }).listening) {
      resolve()
      return
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    server.once('listening', onListening)
    server.once('error', onError)
  })

  return {
    port: options.port,
    host: options.host,
    startedAt,
    resolvedDataDir: DATA_DIR,
    instanceId,
    close,
  }
}
