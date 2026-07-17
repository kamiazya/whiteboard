#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ensureDaemon } from '../../daemon/ensure-daemon.js'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { getDataDir } from '../config.js'
import { isDirectEntryPoint } from '../entrypoint.js'
import { createDaemonClient } from './daemon-client.js'
import { wireMcpLogging } from './logging.js'
import { ensureWorkspaceId } from './session-resolver.js'
import { installStdioLifecycle } from './stdio-lifecycle.js'
import {
  buildDrawDiagramPrompt,
  formatInstalledLibrariesResource,
  formatRecentCanvasesResource,
  getStandaloneHelpText,
  WHITEBOARD_DRAW_PROMPT,
  WHITEBOARD_HELP_URI,
  WHITEBOARD_INSTALLED_LIBRARIES_URI,
  WHITEBOARD_RECENT_CANVASES_URI,
} from './standalone-help.js'
import { listCanvasTool } from './tools/canvas.js'
import { libraryListInstalledTool } from './tools/library.js'
import { registerAllTools } from './tool-registration.js'

export async function createExcalidrawMcpServer() {
  // ensureWorkspaceId memoizes the resolve+save sequence per getDataDir() so the
  // HTTP /mcp handler does not race concurrent requests on the marker file.
  const workspaceId = await ensureWorkspaceId(getDataDir())

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

  const withDaemon = async <T>(
    run: (client: ReturnType<typeof createDaemonClient>) => Promise<T>,
  ): Promise<T> => {
    const daemon = await ensureDaemon()
    const client = createDaemonClient(daemon)
    await client.touch()
    return run(client)
  }

  // Dynamic resources need tool instances for their data fetch.
  const libListInstalled = libraryListInstalledTool(workspaceId)
  const listTool = listCanvasTool()

  server.registerResource(
    'whiteboard-installed-libraries',
    WHITEBOARD_INSTALLED_LIBRARIES_URI,
    {
      title: 'Installed libraries',
      description: 'Dynamic summary of library URLs installed in the current workspace.',
      mimeType: 'text/markdown',
    },
    async () => {
      const libraries = await withDaemon((client) => libListInstalled.execute({}, client))
      return {
        contents: [
          {
            uri: WHITEBOARD_INSTALLED_LIBRARIES_URI,
            mimeType: 'text/markdown',
            text: formatInstalledLibrariesResource(libraries.installedUrls),
          },
        ],
      }
    },
  )

  server.registerResource(
    'whiteboard-recent-canvases',
    WHITEBOARD_RECENT_CANVASES_URI,
    {
      title: 'Recent canvases',
      description: 'Dynamic summary of recently updated canvases across known workspaces.',
      mimeType: 'text/markdown',
    },
    async () => {
      const canvases = await withDaemon((client) => listTool.execute({}, client))
      return {
        contents: [
          {
            uri: WHITEBOARD_RECENT_CANVASES_URI,
            mimeType: 'text/markdown',
            text: formatRecentCanvasesResource(canvases.workspaces),
          },
        ],
      }
    },
  )

  registerAllTools(server, workspaceId, withDaemon)

  return server
}

export async function main() {
  // Initialise OpenTelemetry so traces span the stdio entrypoint too. The
  // SDK is a no-op unless WHITEBOARD_OTEL=1 or OTEL_EXPORTER_OTLP_ENDPOINT
  // is set; the fallback exporter writes JSON to stderr only, which is
  // safe alongside the stdout JSON-RPC channel this entrypoint owns.
  const { initTracing } = await import('../observability/tracing.js')
  await initTracing({ role: 'stdio-mcp' })

  // The HTTP daemon runs prepareDataDir in src/server/index.ts; the stdio
  // entrypoint reaches createExcalidrawMcpServer first, so call the same
  // hook here to keep schema and v0 import bootstrapping symmetric.
  const { prepareDataDir } = await import('../store/db/prepare.js')
  await prepareDataDir(getDataDir())
  const server = await createExcalidrawMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // StdioServerTransport only listens for 'data'/'error' on stdin, never
  // 'end'/'close' — a client disconnect (parent process exit, pipe close)
  // otherwise leaves this process parked on a stdin that will never
  // produce another byte, with no signal handlers to fall back on either.
  // Only wired here (not in createExcalidrawMcpServer, which the HTTP
  // /mcp handler reuses per-request) so a stdio client's disconnect never
  // affects the long-lived HTTP daemon.
  installStdioLifecycle({
    stdin: process.stdin,
    signals: { on: (signal, listener) => process.on(signal, listener) },
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
  })
}

const isEntryPoint = isDirectEntryPoint(import.meta.url)
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`MCP server error: ${err}\n`)
    process.exit(1)
  })
}
