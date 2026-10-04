// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { webMcpTools } from './tool-definitions.js'

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
