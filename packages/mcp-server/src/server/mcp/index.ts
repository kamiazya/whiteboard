#!/usr/bin/env node
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { resolveSelfHostServerDeps } from '../../di/self-host-server-deps.js'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { createCanvasClientNotifier } from '../canvas-client-notifier.js'
import { getDataDir } from '../config.js'
import { ensureWorkspaceId } from '../current-workspace.js'
import { getDb } from '../store/db/index.js'
import { registerDocumentTools } from './document-tools.js'
import { wireMcpLogging } from './logging.js'
import { registerMcpAppsExtension } from './mcp-apps.js'
import {
  buildDrawDiagramPrompt,
  WHITEBOARD_DRAW_PROMPT,
  WHITEBOARD_INSTRUCTIONS,
} from './standalone-help.js'
import { installStdioLifecycle } from './stdio-lifecycle.js'

/**
 * One MCP server over the given `ServerDeps`. An HTTP root passes the deps
 * it composed for `createApp` — the plugin set a deployment registered, the
 * live-audience notifier — so a tool answers with what the root chose, and
 * the container and the facet registry are built once per root rather than
 * once per `/mcp` request. Only the stdio root, which has no `createApp`,
 * composes its own here.
 */
export async function createMcpServer(deps?: ServerDeps) {
  // ensureWorkspaceId memoizes the resolve+save sequence per getDataDir() so the
  // HTTP /mcp handler does not race concurrent requests on the marker file.
  // Called for its prepareDataDir migration side effect ahead of the DB use
  // below; the returned id itself is not needed here.
  await ensureWorkspaceId(getDataDir())

  // Read `version` from package.json at runtime so release-please bumps propagate
  // without source edits.
  const server = new McpServer(
    {
      name: 'whiteboard',
      version: PACKAGE_VERSION,
    },
    // The protocol's own channel for "how do I use this server" — a client
    // injects it into the model's system prompt at initialize. This replaced
    // a help RESOURCE, which no client is obliged to read; see
    // standalone-help.ts for what that cost.
    { instructions: WHITEBOARD_INSTRUCTIONS },
  )

  // Bridge our logger to MCP `notifications/message` and accept
  // `logging/setLevel` from clients. Records still hit stderr in the base
  // sink, so HTTP-only callers and stdio operators retain their view.
  // Wire MCP `notifications/message` capability + log destination, then
  // chain disposal of the destination onto the underlying server's
  // `onclose`. The HTTP `/mcp` handler builds a fresh McpServer per
  // request and closes it (transitively, via `transport.close()`) in a
  // finally block; without this restore() the global log destination set
  // would grow once per request and every record would fan out to the
  // closed transports of every prior request.
  const loggingHandle = wireMcpLogging(server)
  const previousOnClose = server.server.onclose?.bind(server.server)
  server.server.onclose = () => {
    try {
      loggingHandle.restore()
    } finally {
      previousOnClose?.()
    }
  }

  server.registerPrompt(
    WHITEBOARD_DRAW_PROMPT,
    {
      title: 'Draw Diagram',
      description: 'Generate a starter prompt for drawing a new diagram with the whiteboard tools.',
      argsSchema: z.object({
        goal: z.string().describe('What the diagram should explain or align on.'),
        diagramType: z
          .string()
          .optional()
          .describe(
            'Optional diagram type hint such as architecture, sequence, review, or comparison.',
          ),
      }),
    },
    async ({ goal, diagramType }) => ({
      description: 'Starter instructions for creating a new whiteboard diagram.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: buildDrawDiagramPrompt(goal, diagramType),
          },
        },
      ],
    }),
  )

  registerMcpAppsExtension(server)

  registerDocumentTools(server, deps ?? (await stdioRootServerDeps()))

  return server
}

/**
 * The stdio root's own deps. The live-audience bridge is attached here
 * rather than in `resolveServerDeps` (the di graph must not import the
 * routes layer); this root serves the same daemon process, so its tools
 * notify the same streams the HTTP root serves.
 */
async function stdioRootServerDeps(): Promise<ServerDeps> {
  const dataDir = getDataDir()
  const deps = resolveSelfHostServerDeps(await getDb(dataDir), dataDir)
  return { ...deps, clientNotifier: createCanvasClientNotifier(deps.documentIndex) }
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
  // produce another byte. Only wired here (not in
  // createMcpServer, which the HTTP /mcp handler reuses
  // per-request) so a stdio client's disconnect never affects the
  // long-lived HTTP daemon.
  let closeServer: () => Promise<void> = () => Promise.resolve()
  const { shutdownTracing } = await import('../observability/tracing.js')
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
  const { initTracing } = await import('../observability/tracing.js')
  // installStdioLifecycle() above already owns SIGTERM/SIGINT and routes
  // them through shutdownExtra -> shutdownTracing(). Letting initTracing()
  // also register its own SIGTERM/SIGINT listeners would call
  // sdk.shutdown() twice concurrently on a real signal.
  await initTracing({ role: 'stdio-mcp', installSignalHandlers: false })

  // The HTTP daemon runs prepareDataDir in src/server/index.ts; the stdio
  // entrypoint reaches createMcpServer first, so call the same
  // hook here to keep schema bootstrapping symmetric.
  const { prepareDataDir } = await import('../store/db/prepare.js')
  await prepareDataDir(getDataDir())
  // serveStdio owns the era decision for the connection: a 2025-era opening
  // (`initialize`) is served exactly as the old hand-wired transport served
  // it, and a 2026-07-28 opening pins a modern instance from the same
  // factory. A direct `server.connect(new StdioServerTransport())` would
  // speak only the 2025-era protocol.
  const handle = serveStdio(() => createMcpServer(), {
    onerror: (error) => {
      process.stderr.write(`MCP stdio error: ${error}\n`)
    },
  })

  closeServer = () => handle.close()
}
