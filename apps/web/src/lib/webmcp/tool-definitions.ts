import type { WhiteboardCommands } from '../commands/index.js'
import getAppContextJsonSchema from './tool-result-schemas/get-app-context.schema.json' with {
  type: 'json',
}
import getSceneSummaryJsonSchema from './tool-result-schemas/get-scene-summary.schema.json' with {
  type: 'json',
}

// Every WebMCP tool this app exposes takes no arguments today — a
// literal, not derived from a Zod schema, because there is no input schema
// to keep in sync with yet. If a future tool needs an argument, give it a
// proper Zod input schema next to its result schema instead of reusing this.
const emptyObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/**
 * A read-only WebMCP tool this app registers via `useBrowserToolRegistry`.
 * `resultSchema` is a static JSON Schema literal (not derived via
 * zod-to-json-schema) so it can be imported unchanged by the Node-side
 * canary script without a TypeScript build step; `tool-definitions.test.ts`
 * asserts it stays in agreement with the Zod result schema the executor
 * actually parses against.
 */
export interface WebMcpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly resultSchema: Record<string, unknown>
  execute(commands: WhiteboardCommands): Promise<unknown>
}

const whiteboardGetAppContextTool: WebMcpToolDefinition = {
  name: 'whiteboard_get_app_context',
  description:
    'Read-only: reports which provider mode this whiteboard is running in and which canvas is currently open. Never includes secrets, tokens, or connection details.',
  inputSchema: emptyObjectJsonSchema,
  resultSchema: getAppContextJsonSchema,
  execute: (commands) => commands.getAppContext(),
}

const whiteboardGetSceneSummaryTool: WebMcpToolDefinition = {
  name: 'whiteboard_get_scene_summary',
  description:
    'Read-only: reports element counts, selection count, and viewport position for the current canvas. Never returns full scene content (element geometry, text, or files).',
  inputSchema: emptyObjectJsonSchema,
  resultSchema: getSceneSummaryJsonSchema,
  execute: (commands) => commands.getSceneSummary(),
}

/** The full set of tools `useBrowserToolRegistry` registers. */
export const webMcpTools: readonly WebMcpToolDefinition[] = [
  whiteboardGetAppContextTool,
  whiteboardGetSceneSummaryTool,
]
