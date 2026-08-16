import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { getAppContextResultSchema } from '../commands/types.js'
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
  // ExcalidrawImperativeAPI, which is going away, and has no OpenCanvas-shaped
  // replacement yet. It must stay absent rather than be silently reintroduced
  // by a later merge.
  it('does not register the removed Excalidraw-backed scene-summary tool', () => {
    const names = webMcpTools.map((tool) => tool.name)
    expect(names).not.toContain('whiteboard_get_scene_summary')
  })
})

// Minimal structural JSON Schema validator covering only the subset this
// repo's static .schema.json literals use (object/string/integer/number/null,
// required, additionalProperties: false, enum, const, minimum, anyOf). Not a
// general JSON Schema implementation — just enough to prove the literal and
// the Zod schema it mirrors agree on shape, without adding an ajv/
// zod-to-json-schema dependency for Phase 0.
//
// Every number/integer field in this repo's result schemas mirrors a Zod
// `.finite()` or `.int().nonnegative()` constraint, so this validator
// rejects NaN/Infinity for both — a JSON Schema literal that let a
// non-finite number through would silently disagree with the Zod schema it
// claims to mirror.
function matchesJsonSchema(schema: unknown, value: unknown): boolean {
  const s = schema as Record<string, unknown>
  if (Array.isArray(s.anyOf)) {
    return s.anyOf.some((sub) => matchesJsonSchema(sub, value))
  }
  if (Array.isArray(s.enum)) {
    if (!s.enum.includes(value)) return false
  }
  if ('const' in s) {
    if (value !== s.const) return false
  }
  if (s.type === 'null') return value === null
  if (s.type === 'string') return typeof value === 'string'
  if (s.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false
    return matchesMinimum(s, value)
  }
  if (s.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    return matchesMinimum(s, value)
  }
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

function matchesMinimum(s: Record<string, unknown>, value: number): boolean {
  if (typeof s.minimum !== 'number') return true
  return value >= s.minimum
}

describe('WebMCP result JSON-Schema literals agree with the Zod schemas', () => {
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

  it('get-app-context: rejects a provider.mode value outside the enum, in both directions', () => {
    const wrongEnum = {
      provider: { mode: 'not-a-real-mode' },
      canvas: null,
    }

    expect(getAppContextResultSchema.safeParse(wrongEnum).success).toBe(false)
    expect(matchesJsonSchema(whiteboardGetAppContextJsonSchema(), wrongEnum)).toBe(false)
  })

  it('get-app-context: rejects a canvas.kind that does not match its const, in both directions', () => {
    const wrongConst = {
      provider: { mode: 'daemon' },
      canvas: { kind: 'browser-local', workspaceId: 'ws1', slug: 'c1' },
    }

    expect(getAppContextResultSchema.safeParse(wrongConst).success).toBe(false)
    expect(matchesJsonSchema(whiteboardGetAppContextJsonSchema(), wrongConst)).toBe(false)
  })
})

// Fuzzed cross-check, in addition to the fixed fixtures above: hand-picked
// fixtures only prove the two schemas agree on the exact cases someone
// thought to write down. A regression like dropping a `required` entry from
// the JSON Schema literal, or adding a stricter Zod constraint (e.g.
// `.positive()` on zoom) without mirroring it in the literal, would still
// pass every fixture above. Generating many field-value combinations —
// valid, negative, non-integer, non-finite, and wrong-typed — and requiring
// both validators to agree on every one closes that gap without adding a
// zod-to-json-schema dependency.
const daemonCanvasArb = fc.record(
  {
    kind: fc.constantFrom('daemon', 'browser-local', 'other'),
    workspaceId: fc.oneof(fc.string(), fc.constant(undefined)),
    slug: fc.oneof(fc.string(), fc.constant(undefined)),
    documentId: fc.oneof(fc.string(), fc.constant(undefined)),
  },
  { requiredKeys: [] },
)

const appContextPayloadArb = fc.record(
  {
    provider: fc.record(
      { mode: fc.constantFrom('daemon', 'browser-local', 'other') },
      { requiredKeys: [] },
    ),
    canvas: fc.oneof(fc.constant(null), daemonCanvasArb),
  },
  { requiredKeys: [] },
)

describe('WebMCP result JSON-Schema literals agree with the Zod schemas (fuzzed)', () => {
  fcTest.prop([appContextPayloadArb], withDefaults())(
    'get-app-context: the JSON Schema literal and the Zod schema always agree on validity',
    (payload) => {
      const zodAccepts = getAppContextResultSchema.safeParse(payload).success
      const jsonSchemaAccepts = matchesJsonSchema(whiteboardGetAppContextJsonSchema(), payload)
      expect(jsonSchemaAccepts).toBe(zodAccepts)
    },
  )
})

function whiteboardGetAppContextJsonSchema(): Record<string, unknown> {
  return webMcpTools.find((t) => t.name === 'whiteboard_get_app_context')!.resultSchema
}
