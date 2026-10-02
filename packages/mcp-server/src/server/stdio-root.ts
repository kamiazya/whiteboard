import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { bootLocalDeps } from '../di/boot-local-deps.js'
import { startBackgroundWork } from './background-work.js'
import { getDataDir } from './config.js'
import { warnWhenDataDirIsTempFallback } from './data-dir-fallback.js'
import { createMcpServer } from './mcp/server.js'
import { installStdioLifecycle } from './mcp/stdio-lifecycle.js'
import { routeServerCoreLogs } from './server-core-logs.js'
import { stdioBackgroundWork } from './shared-background-work.js'

/**
 * The stdio root: the published entry, `npx @kamiazya/whiteboard-mcp`. It is a
 * composition root with nobody above it to hand it a data directory, so it
 * resolves `getDataDir()` once and boots everything it serves from that — the
 * deps, and the `StoreScope` its background work runs over.
 *
 * It opens the data directory's store in its OWN process and never reaches the
 * daemon, so no SSE client can ever be in its sync audience — a notifier in
 * the deps would announce every edit, viewport request and agent activity to
 * streams that exist only in the daemon's process. None is attached:
 * `wb_viewport_set` answers `delivered: false` honestly, and a browser on the
 * daemon sees a stdio edit when the daemon's workspace tail reads it, not
 * live. Bridging the two processes is the daemon's `/mcp`, which the
 * development proxy and a client with socket access use instead of this entry.
 */
export function bootStdioRoot() {
  const dataDir = getDataDir()
  warnWhenDataDirIsTempFallback(dataDir)
  return bootLocalDeps(dataDir)
}

export async function main() {
  // Install stdio/signal handling before any startup work (tracing init,
  // prepareDataDir, server creation, transport connect) runs. Those steps
  // can take a while, and once *any* listener is registered for a signal,
  // Node no longer applies its default terminate-the-process behavior.
  // Registering our lifecycle handler first guarantees a signal arriving
  // mid-startup still exits the process instead of being swallowed while
  // nothing else is listening for it. closeServer starts as a no-op and is
  // upgraded once the real server exists.
  //
  // StdioServerTransport only listens for 'data'/'error' on stdin, never
  // 'end'/'close' — a client disconnect (parent process exit, pipe close)
  // otherwise leaves this process parked on a stdin that will never
  // produce another byte. Only wired here (not in `createMcpServer`, which
  // the HTTP /mcp handler reuses per-request) so a stdio client's disconnect
  // never affects the long-lived HTTP daemon.
  let closeServer: () => Promise<void> = () => Promise.resolve()
  const { shutdownTracing } = await import('./observability/tracing.js')
  installStdioLifecycle({
    stdin: process.stdin,
    signals: { on: (signal, listener) => process.on(signal, listener) },
    closeServer: () => closeServer(),
    // Routes through shutdownTracing() so the process does not exit while
    // a pending span export is still in flight; bounded by the same
    // GRACEFUL_SHUTDOWN_TIMEOUT_MS budget. initTracing() below is told not
    // to install its own SIGTERM/SIGINT listeners so this is the only
    // signal-driven path that calls sdk.shutdown().
    shutdownExtra: () => shutdownTracing(),
    exit: (code) => process.exit(code),
  })

  // Initialise OpenTelemetry so traces span the stdio entrypoint too. The
  // SDK is a no-op unless WHITEBOARD_OTEL=1 or OTEL_EXPORTER_OTLP_ENDPOINT
  // is set; the fallback exporter writes JSON to stderr only, which is
  // safe alongside the stdout JSON-RPC channel this entrypoint owns.
  const { initTracing } = await import('./observability/tracing.js')
  // installStdioLifecycle() above already owns SIGTERM/SIGINT and routes
  // them through shutdownExtra -> shutdownTracing(). Letting initTracing()
  // also register its own SIGTERM/SIGINT listeners would call
  // sdk.shutdown() twice concurrently on a real signal.
  await initTracing({ role: 'stdio-mcp', installSignalHandlers: false })

  closeServer = await startStdioServer()
}

/**
 * Boots the data dir, arms the root's background work and serves the
 * connection. Answers how to close it all: the transport first, so the
 * shutdown flush sees every write the session made.
 */
async function startStdioServer(): Promise<() => Promise<void>> {
  // No app is built here, so the root arms server-core's log sink itself.
  routeServerCoreLogs()
  // Booted once at startup rather than on the first connection, so a data
  // dir that cannot be migrated fails the process here, and every connection
  // serves the one set of deps its background work runs beside.
  const { serverDeps, scope } = await bootStdioRoot()
  // Armed before the first connection can write.
  const backgroundWork = startBackgroundWork(stdioBackgroundWork(scope))
  // serveStdio owns the era decision for the connection: a 2025-era opening
  // (`initialize`) is served exactly as the old hand-wired transport served
  // it, and a 2026-07-28 opening pins a modern instance from the same
  // factory. A direct `server.connect(new StdioServerTransport())` would
  // speak only the 2025-era protocol.
  const handle = serveStdio(() => createMcpServer(serverDeps), {
    onerror: (error) => {
      process.stderr.write(`MCP stdio error: ${error}\n`)
    },
  })

  return async () => {
    try {
      await handle.close()
    } finally {
      await backgroundWork.stopAll()
    }
  }
}
