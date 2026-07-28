#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { getDataDir } from '../config.js'
import { isDirectEntryPoint } from '../entrypoint.js'
import { registerMcpAppsExtension } from './mcp-apps.js'
import { wireMcpLogging } from './logging.js'
import { ensureWorkspaceId } from './session-resolver.js'
import { installStdioLifecycle } from './stdio-lifecycle.js'
import {
  buildDrawDiagramPrompt,
  getStandaloneHelpText,
  WHITEBOARD_DRAW_PROMPT,
  WHITEBOARD_HELP_URI,
} from './standalone-help.js'
import { registerOpenCanvasTools } from './opencanvas-tools.js'
import { getDb } from '../store/db/index.js'
import { LibsqlCanvasDocStore } from '../store/libsql/libsql-canvas-doc-store.js'
import { LibsqlWorkspaceIndex } from '../store/libsql/libsql-workspace-index.js'
import { FsBlobStore } from '../store/fs/fs-blob-store.js'

export async function createMcpServer() {
  // ensureWorkspaceId memoizes the resolve+save sequence per getDataDir() so the
  // HTTP /mcp handler does not race concurrent requests on the marker file.
  // Called for its prepareDataDir migration side effect ahead of the DB use
  // below; the returned id itself is not needed here.
  await ensureWorkspaceId(getDataDir())

  // Read `version` from package.json at runtime so release-please bumps propagate
  // without source edits.
  const server = new McpServer({
    name: 'whiteboard',
    version: PACKAGE_VERSION,
  })

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

  server.registerResource(
    'whiteboard-help',
    WHITEBOARD_HELP_URI,
    {
      title: 'Whiteboard MCP quickstart',
      description: 'Standalone help for raw MCP clients that do not load Claude/Codex skills.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: WHITEBOARD_HELP_URI,
          mimeType: 'text/markdown',
          text: getStandaloneHelpText(),
        },
      ],
    }),
  )

  server.registerPrompt(
    WHITEBOARD_DRAW_PROMPT,
    {
      title: 'Draw Diagram',
      description: 'Generate a starter prompt for drawing a new diagram with the whiteboard tools.',
      argsSchema: {
        goal: z.string().describe('What the diagram should explain or align on.'),
        diagramType: z
          .string()
          .optional()
          .describe(
            'Optional diagram type hint such as architecture, sequence, review, or comparison.',
          ),
      },
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

  const dataDir = getDataDir()
  const db = await getDb(dataDir)
  registerOpenCanvasTools(server, {
    canvasDocStore: new LibsqlCanvasDocStore(db),
    workspaceIndex: new LibsqlWorkspaceIndex(db),
    blobStore: new FsBlobStore(dataDir),
  })

  return server
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
  // hook here to keep schema and v0 import bootstrapping symmetric.
  const { prepareDataDir } = await import('../store/db/prepare.js')
  await prepareDataDir(getDataDir())
  const server = await createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  closeServer = () => server.close()
}

const isEntryPoint = isDirectEntryPoint(import.meta.url)
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`MCP server error: ${err}\n`)
    process.exit(1)
  })
}
