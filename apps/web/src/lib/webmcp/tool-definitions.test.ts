import { describe, expect, it } from 'vitest'
import { getAppContextResultSchema, getSceneSummaryResultSchema } from '../commands/types.js'
import { webMcpTools } from './tool-definitions.js'

describe('webMcpTools manifest', () => {
  // Blocking metaguard: any change to a tool's name, description, or input
  // schema shape must show up as a reviewable diff in this snapshot, the
  // same discipline mcp-server applies to its ALL_REGISTERED_TOOLS list.
  it('matches the pinned name/description/inputSchema snapshot', () => {
    const manifest = webMcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))

    expect(manifest).toMatchInlineSnapshot(`
      [
        {
          "description": "Read-only: reports which provider mode this whiteboard is running in and which canvas is currently open. Never includes secrets, tokens, or connection details.",
          "inputSchema": {
            "additionalProperties": false,
            "properties": {},
            "type": "object",
          },
          "name": "whiteboard_get_app_context",
        },
        {
          "description": "Read-only: reports element counts, selection count, and viewport position for the current canvas. Never returns full scene content (element geometry, text, or files).",
          "inputSchema": {
            "additionalProperties": false,
            "properties": {},
            "type": "object",
          },
          "name": "whiteboard_get_scene_summary",
        },
      ]
    `)
  })

  it('every tool name uses the whiteboard_ prefix', () => {
    for (const tool of webMcpTools) {
      expect(tool.name.startsWith('whiteboard_')).toBe(true)
    }
  })
})

// Minimal structural JSON Schema validator covering only the subset this
// repo's static .schema.json literals use (object/string/integer/number/null,
// required, additionalProperties: false, enum, const, anyOf). Not a general
// JSON Schema implementation — just enough to prove the literal and the Zod
// schema it mirrors agree on shape, without adding an ajv/zod-to-json-schema
// dependency for Phase 0.
function matchesJsonSchema(schema: unknown, value: unknown): boolean {
  const s = schema as Record<string, unknown>
  if (Array.isArray(s.anyOf)) {
    return s.anyOf.some((sub) => matchesJsonSchema(sub, value))
  }
  if (s.type === 'null') return value === null
  if (s.type === 'string') return typeof value === 'string'
  if (s.type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (s.type === 'number') return typeof value === 'number'
  if (s.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const obj = value as Record<string, unknown>
    const required = (s.required as string[] | undefined) ?? []
    for (const key of required) {
      if (!(key in obj)) return false
    }
    const properties = (s.properties as Record<string, unknown> | undefined) ?? {}
    for (const [key, val] of Object.entries(obj)) {
      if (key in properties) {
        if (!matchesJsonSchema(properties[key], val)) return false
      } else if (s.additionalProperties === false) {
        return false
      } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        if (!matchesJsonSchema(s.additionalProperties, val)) return false
      }
    }
    return true
  }
  return true
}

describe('WebMCP result JSON-Schema literals agree with the Zod schemas', () => {
  it('get-scene-summary: accepts a valid fixture and rejects an extra-key fixture, in both directions', () => {
    const valid = {
      elementCount: 2,
      selectedCount: 1,
      typeCounts: { rectangle: 2 },
      viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
    }
    const withExtraKey = { ...valid, secret: 'leak' }

    expect(getSceneSummaryResultSchema.safeParse(valid).success).toBe(true)
    expect(matchesJsonSchema(whiteboardGetSceneSummaryJsonSchema(), valid)).toBe(true)

    expect(getSceneSummaryResultSchema.safeParse(withExtraKey).success).toBe(false)
    expect(matchesJsonSchema(whiteboardGetSceneSummaryJsonSchema(), withExtraKey)).toBe(false)
  })

  it('get-app-context: accepts a valid fixture and rejects an extra-key fixture, in both directions', () => {
    const valid = {
      provider: { mode: 'daemon' },
      canvas: { kind: 'daemon', workspaceId: 'ws1', slug: 'c1' },
    }
    const withExtraKey = {
      provider: { mode: 'daemon', daemonBaseUrl: 'http://leak' },
      canvas: { kind: 'daemon', workspaceId: 'ws1', slug: 'c1' },
    }

    expect(getAppContextResultSchema.safeParse(valid).success).toBe(true)
    expect(matchesJsonSchema(whiteboardGetAppContextJsonSchema(), valid)).toBe(true)

    expect(getAppContextResultSchema.safeParse(withExtraKey).success).toBe(false)
    expect(matchesJsonSchema(whiteboardGetAppContextJsonSchema(), withExtraKey)).toBe(false)
  })
})

function whiteboardGetSceneSummaryJsonSchema(): Record<string, unknown> {
  return webMcpTools.find((t) => t.name === 'whiteboard_get_scene_summary')!.resultSchema
}

function whiteboardGetAppContextJsonSchema(): Record<string, unknown> {
  return webMcpTools.find((t) => t.name === 'whiteboard_get_app_context')!.resultSchema
}
