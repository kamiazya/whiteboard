import type { z } from 'zod'
import type { WhiteboardCommands } from '../commands/index.js'
import type { getAppContextInputSchema, getAppContextResultSchema } from '../commands/types.js'

// Every WebMCP tool this app exposes takes no arguments today — a
// literal, not derived from a Zod schema, because there is no input schema
// to keep in sync with yet. If a future tool needs an argument, give it a
// proper Zod input schema next to its command instead of reusing this.
const emptyObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/**
 * A read-only WebMCP tool this app registers via `useBrowserToolRegistry`.
 * The WebMCP `ModelContextTool` dictionary carries no result or output
 * schema (name, title, description, inputSchema, execute, annotations), so a
 * tool declares none: what it returns is whatever the command's Zod result
 * schema parses. `execute`'s return type is derived from the generic
 * `Result` schema (via `z.infer`) rather than widened to `Promise<unknown>`,
 * so a tool's declared result type can never drift from what its command
 * actually parses against.
 *
 * `input` is the raw, not-yet-validated payload the WebMCP host passes at
 * call time; each tool forwards it into its underlying command, which
 * re-validates against its own Zod input schema (`assertValidInput` in
 * create-commands.ts) and rejects with an `invalid-input` CommandError on
 * mismatch. `execute` itself does not parse `input` — it is not this
 * layer's job to duplicate the command's own validation.
 */
export interface WebMcpToolDefinition<Result extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  // Every tool this app exposes only reads state — never mutates the
  // canvas, settings, or anything else — so this is required rather than
  // defaulted, forcing a future non-read-only tool to make that choice
  // explicit instead of silently inheriting a wrong default.
  readonly readOnlyHint: boolean
  execute(commands: WhiteboardCommands, input: unknown): Promise<z.infer<Result>>
}

const whiteboardGetAppContextTool: WebMcpToolDefinition<typeof getAppContextResultSchema> = {
  name: 'whiteboard_get_app_context',
  description:
    'Read-only: reports which provider mode this whiteboard is running in and which canvas is currently open. Never includes secrets, tokens, or connection details.',
  inputSchema: emptyObjectJsonSchema,
  readOnlyHint: true,
  execute: (commands, input) =>
    commands.getAppContext(input as z.infer<typeof getAppContextInputSchema>),
}

/**
 * The full set of tools `useBrowserToolRegistry` registers. Widened to the
 * default `WebMcpToolDefinition<z.ZodTypeAny>` deliberately: this array is a
 * genuinely heterogeneous collection (each tool's own `Result` schema
 * differs), so the array element type cannot be more specific than
 * `z.ZodTypeAny` without an existential wrapper. Each definition above still
 * carries its own precise `Result` type at the point it is declared.
 */
export const webMcpTools: readonly WebMcpToolDefinition[] = [whiteboardGetAppContextTool]
