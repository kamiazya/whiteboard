// @vitest-environment node
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
  // ExcalidrawImperativeAPI, which is going away, and has no document-shaped
  // replacement yet. It must stay absent rather than be silently reintroduced
  // by a later merge.
  it('does not register the removed Excalidraw-backed scene-summary tool', () => {
    const names = webMcpTools.map((tool) => tool.name)
    expect(names).not.toContain('whiteboard_get_scene_summary')
  })
})

// Minimal structural JSON Schema validator covering only the subset this
// repo's static .schema.json literals use. Not a general JSON Schema
// implementation — just enough to prove the literal and the Zod schema it
// mirrors agree on shape, without adding an ajv/zod-to-json-schema
// dependency for Phase 0.
//
// Every number/integer field in this repo's result schemas mirrors a Zod
// `.finite()` or `.int().nonnegative()` constraint, so this validator
// rejects NaN/Infinity for both — a JSON Schema literal that let a
// non-finite number through would silently disagree with the Zod schema it
// claims to mirror.
//
// WHAT IT DOES NOT IMPLEMENT, IT REFUSES. A partial validator that skips
// the keyword it has never met does not report a disagreement — it reports
// AGREEMENT, because a constraint it ignores is a constraint it applies to
// nobody. Add `"minLength": 1` to a literal beside a Zod `.min(1)` and the
// fuzzed property below goes on passing over every string the generator
// draws, including the empty one the two schemas now judge differently.
// So an unknown keyword or an unimplemented `type` throws, naming itself
// and its path, and `assertSupportedJsonSchema` walks the whole schema up
// front rather than waiting for a value to reach the branch that carries
// it.
//
// Widening the subset is a deliberate edit to both sets below plus the
// branch that reads it — which is the point: reaching for a keyword this
// validator cannot check should cost a decision, not pass silently.
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'anyOf',
  'required',
  'properties',
  'additionalProperties',
  'minimum',
  'exclusiveMinimum',
  // Annotations: they carry no constraint, so ignoring them IS correct.
  '$schema',
  '$id',
  'title',
  'description',
])

const SUPPORTED_TYPES = new Set(['null', 'string', 'integer', 'number', 'object'])

/**
 * Every keyword and every `type` in `schema` is one `matchesJsonSchema`
 * really checks. Throws naming the offender and where it sits.
 */
function assertSupportedJsonSchema(schema: unknown, path = '#'): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`matchesJsonSchema: ${path} is not a schema object`)
  }
  const s = schema as Record<string, unknown>
  for (const keyword of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `matchesJsonSchema does not implement the JSON Schema keyword '${keyword}' (at ${path}), so it would ignore it and report agreement it has not checked. Implement it above and add it to SUPPORTED_KEYWORDS, or express the constraint another way.`,
      )
    }
  }
  if (typeof s.type === 'string' && !SUPPORTED_TYPES.has(s.type)) {
    throw new Error(
      `matchesJsonSchema does not implement type '${s.type}' (at ${path}), so it would accept every value there.`,
    )
  }
  if (Array.isArray(s.anyOf)) {
    s.anyOf.forEach((sub, index) => {
      assertSupportedJsonSchema(sub, `${path}/anyOf/${index}`)
    })
  }
  if (s.properties && typeof s.properties === 'object') {
    for (const [key, sub] of Object.entries(s.properties as Record<string, unknown>)) {
      assertSupportedJsonSchema(sub, `${path}/properties/${key}`)
    }
  }
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    assertSupportedJsonSchema(s.additionalProperties, `${path}/additionalProperties`)
  }
}

function matchesJsonSchema(schema: unknown, value: unknown): boolean {
  assertSupportedJsonSchema(schema)
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
      canvas: { kind: 'daemon', workspaceId: 'ws1', path: 'c1' },
    }
    const withExtraKey = {
      provider: { mode: 'daemon', daemonBaseUrl: 'http://leak' },
      canvas: { kind: 'daemon', workspaceId: 'ws1', path: 'c1' },
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
      canvas: { kind: 'browser', workspaceId: 'ws1', path: 'c1' },
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
    kind: fc.constantFrom('daemon', 'browser', 'other'),
    workspaceId: fc.oneof(fc.string(), fc.constant(undefined)),
    path: fc.oneof(fc.string(), fc.constant(undefined)),
    documentId: fc.oneof(fc.string(), fc.constant(undefined)),
  },
  { requiredKeys: [] },
)

const appContextPayloadArb = fc.record(
  {
    provider: fc.record(
      { mode: fc.constantFrom('daemon', 'browser', 'other') },
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

describe('the parity checker refuses what it cannot check', () => {
  // The guard that makes the property above mean something: every literal a
  // tool ships is inside the subset, so nothing the fuzzer agrees on was
  // agreed by omission.
  it('every WebMCP tool ships schemas inside the subset', () => {
    for (const tool of webMcpTools) {
      expect(() => assertSupportedJsonSchema(tool.inputSchema), tool.name).not.toThrow()
      expect(() => assertSupportedJsonSchema(tool.resultSchema), tool.name).not.toThrow()
    }
    expect(webMcpTools.length).toBeGreaterThan(0)
  })

  it('throws on a keyword it does not implement, naming the keyword and the path', () => {
    expect(() =>
      assertSupportedJsonSchema({
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
      }),
    ).toThrow(/'minLength'.*#\/properties\/name/s)
  })

  it('throws on a type it does not implement, rather than accepting every value', () => {
    expect(() => assertSupportedJsonSchema({ type: 'array' })).toThrow(/type 'array'/)
    expect(() => assertSupportedJsonSchema({ type: 'boolean' })).toThrow(/type 'boolean'/)
  })

  it('reaches a branch no value would visit', () => {
    // `anyOf`'s second arm is unreachable for the value below, so a check
    // driven by values alone would never see the unsupported keyword in it.
    const schema = {
      anyOf: [{ type: 'null' }, { type: 'string', pattern: '^a' }],
    }

    expect(matchesJsonSchema({ anyOf: [{ type: 'null' }] }, null)).toBe(true)
    expect(() => assertSupportedJsonSchema(schema)).toThrow(/'pattern'/)
  })

  it('admits annotations, which carry no constraint', () => {
    expect(() =>
      assertSupportedJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'a thing',
        description: 'what it is',
        type: 'object',
      }),
    ).not.toThrow()
  })
})

function whiteboardGetAppContextJsonSchema(): Record<string, unknown> {
  return webMcpTools.find((t) => t.name === 'whiteboard_get_app_context')!.resultSchema
}
