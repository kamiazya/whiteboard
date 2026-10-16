// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getAppContextInputSchema } from '../commands/types.js'
import { webMcpTools } from './tool-definitions.js'

// The Zod input schema each tool's command validates against, named here
// independently of the tool definition so the check cannot borrow the
// definition's own derivation as its oracle.
const COMMAND_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  whiteboard_get_app_context: getAppContextInputSchema,
}

describe('webMcpTools manifest', () => {
  // Blocking metaguard: any change to a tool's name, description, or input
  // schema shape must show up as a reviewable diff in this pinned literal,
  // the same discipline mcp-server applies to its ALL_REGISTERED_TOOLS list.
  // A plain toEqual (not toMatchInlineSnapshot) so the test runs identically
  // under every vitest project, including ones without snapshot support.
  it('matches the pinned name/description/inputSchema manifest', () => {
    const manifest = webMcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))

    expect(manifest).toEqual([
      {
        name: 'whiteboard_get_app_context',
        description:
          'Read-only: reports which provider mode this whiteboard is running in and which canvas is currently open. Never includes secrets, tokens, or connection details.',
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: 'object',
        },
      },
    ])
  })

  // What the host is told it may send has to be what the command accepts: a
  // compliant host never sends an argument the advertised schema forbids, so
  // an advertised schema stricter than the command's silently removes it.
  it('advertises the JSON Schema derived from its command input schema', () => {
    expect(Object.keys(COMMAND_INPUT_SCHEMAS).sort()).toEqual(
      webMcpTools.map((tool) => tool.name).sort(),
    )
    for (const tool of webMcpTools) {
      const commandSchema = COMMAND_INPUT_SCHEMAS[tool.name]
      expect(commandSchema, tool.name).toBeDefined()
      const { $schema: _root, ...derived } = z.toJSONSchema(commandSchema as z.ZodType)
      expect(tool.inputSchema, tool.name).toEqual(derived)
      expect(tool.input, tool.name).toBe(commandSchema)
    }
  })

  it('every tool name uses the whiteboard_ prefix', () => {
    for (const tool of webMcpTools) {
      expect(tool.name.startsWith('whiteboard_')).toBe(true)
    }
  })

  // Regression guard: this tool read the live scene through
  // ExcalidrawImperativeAPI, which is going away, and has no document-shaped
  // replacement yet. It must stay absent rather than be silently reintroduced
  // by a later merge.
  it('does not register the removed Excalidraw-backed scene-summary tool', () => {
    const names = webMcpTools.map((tool) => tool.name)
    expect(names).not.toContain('whiteboard_get_scene_summary')
  })
})
