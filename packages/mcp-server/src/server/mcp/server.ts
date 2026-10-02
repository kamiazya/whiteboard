import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { registerDocumentTools } from './document-tools.js'
import { wireMcpLogging } from './logging.js'
import { registerMcpAppsExtension } from './mcp-apps.js'
import {
  buildDrawDiagramPrompt,
  WHITEBOARD_DRAW_PROMPT,
  WHITEBOARD_INSTRUCTIONS,
} from './standalone-help.js'

/**
 * Bridges our logger to MCP `notifications/message` and accepts
 * `logging/setLevel` from clients. Records still hit stderr in the base
 * sink, so HTTP-only callers and stdio operators retain their view.
 *
 * The destination is disposed through the underlying server's `onclose`. The
 * HTTP `/mcp` handler builds a fresh McpServer per request and closes it
 * (transitively, via `transport.close()`) in a finally block; without this
 * restore() the global log destination set would grow once per request and
 * every record would fan out to the closed transports of every prior request.
 */
function bridgeLogging(server: McpServer): void {
  const loggingHandle = wireMcpLogging(server)
  const previousOnClose = server.server.onclose?.bind(server.server)
  server.server.onclose = () => {
    try {
      loggingHandle.restore()
    } finally {
      previousOnClose?.()
    }
  }
}

function registerDrawPrompt(server: McpServer): void {
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
          content: { type: 'text', text: buildDrawDiagramPrompt(goal, diagramType) },
        },
      ],
    }),
  )
}

/**
 * One MCP server over the `ServerDeps` a root composed. The HTTP root passes
 * the deps it built for `createApp` — the plugin set a deployment registered,
 * the live-audience notifier — so a tool answers with what the root chose, and
 * the container and the facet registry are built once per root rather than
 * once per `/mcp` request. The stdio root boots its own (`stdio-root.ts`).
 *
 * This module is a library, not a root: it reads no data directory and boots
 * nothing, so the deps it is handed are the deps it serves.
 */
export async function createMcpServer(deps: ServerDeps) {
  const server = new McpServer(
    {
      name: 'whiteboard',
      // Read from package.json at runtime so release-please bumps propagate
      // without source edits.
      version: PACKAGE_VERSION,
    },
    // The protocol's own channel for "how do I use this server" — a client
    // injects it into the model's system prompt at initialize. This replaced
    // a help RESOURCE, which no client is obliged to read; see
    // standalone-help.ts for what that cost.
    { instructions: WHITEBOARD_INSTRUCTIONS },
  )
  bridgeLogging(server)
  registerDrawPrompt(server)
  registerMcpAppsExtension(server)
  registerDocumentTools(server, deps)
  return server
}
