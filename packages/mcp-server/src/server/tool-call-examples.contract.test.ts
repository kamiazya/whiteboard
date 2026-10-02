import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createServer, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { repoRoot } from '../shared/test-utils/repo-root.js'

// A tool call written into a skill, the README or a docs page is read and
// copied by a model or an operator, and nothing compiles it: the drawing skill
// taught `edge: { fromNode, toNode, toEnd }` while the schema wanted
// `{ from: { node }, to: { node, end } }`, and the first worked example of the
// plugin was refused on every copy. `skills-tool-surface.test.ts` holds the
// tool NAMES; this holds the ARGUMENTS, by parsing each example through the
// input schema the server registers for that tool.
const ROOT = repoRoot()
// Ids are canonical ULIDs, which also satisfy the workspace-handle grammar, so one
// stand-in is valid wherever an example leaves an id for the reader to fill.
const PLACEHOLDER = '01JZ0000000000000000000001'

// Only the schemas are read, never an `execute`, so the tool factories close
// over a deps bag that is never touched.
const INPUT_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map(
  Object.values(createServer({} as ServerDeps).tools).map((tool) => [tool.name, tool.inputSchema]),
)
const TOOL_NAME = [...INPUT_SCHEMAS.keys()].join('|')
const CALL_OPEN = new RegExp(`\\b(${TOOL_NAME})\\(\\s*\\{`, 'g')

function markdownUnder(dir: string, skip: (path: string) => boolean = () => false): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (skip(path)) return []
    if (entry.isDirectory()) return markdownUnder(path, skip)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

// ADRs record what was decided at a point in time, so a shape they quote may
// be one the code has since retired.
const ADR_DIR = join(ROOT, 'docs/contributing/adr')
const SOURCES: readonly string[] = [
  ...markdownUnder(join(ROOT, 'skills')),
  join(ROOT, 'README.md'),
  ...markdownUnder(join(ROOT, 'docs'), (path) => path === ADR_DIR),
]

interface Example {
  readonly file: string
  readonly line: number
  /** The call as written, whitespace collapsed: the allowlist's key. */
  readonly text: string
  readonly tool: string
  readonly evaluate: () => unknown
}

/** The text of the `{...}` opening at `start`, comments and strings skipped; undefined if unbalanced. */
function balancedBraces(source: string, start: number): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = undefined
    } else if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i) - 1
      if (i < 0) return undefined
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) return undefined
      i = end + 1
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}' && --depth === 0) {
      return source.slice(start, i + 1)
    }
  }
  return undefined
}

// An identifier the example leaves bare (`workspaceId`, `a`, `saved[0].version.id`)
// stands for a value the reader supplies. Any property read or call on it is
// another placeholder, and a function in the result is where one ended up.
function placeholderScope(): object {
  const stand: object = new Proxy(() => undefined, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => PLACEHOLDER
      return key === 'toJSON' ? undefined : stand
    },
    apply: () => stand,
  })
  return new Proxy(Object.create(null), {
    has: (_target, key) => typeof key === 'string' && !(key in globalThis),
    get: (_target, key) => (key === Symbol.unscopables ? undefined : stand),
  })
}

// An elided entry (`[ /* ...adds... */, { op: "tidy" } ]`) is a JS array hole.
// `flatMap` skips holes, so the elision drops out and what is written is still
// checked, rather than every elided example needing an allowlist entry.
function toPlainJson(value: unknown): unknown {
  if (typeof value === 'function') return PLACEHOLDER
  if (typeof value === 'string' && /^<[^<>]*>$/.test(value)) return PLACEHOLDER
  if (Array.isArray(value)) return value.flatMap((item) => [toPlainJson(item)])
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlainJson(v)]))
  }
  return value
}

function evaluateLiteral(literal: string): unknown {
  // `with` is what lets a bare identifier resolve to the proxy; a Function
  // body is sloppy-mode, which is the only mode that allows it.
  const run = new Function('scope', `with (scope) { return (${literal}) }`)
  return toPlainJson(run(placeholderScope()))
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function callExamples(file: string, source: string): Example[] {
  return [...source.matchAll(CALL_OPEN)].flatMap((match) => {
    const open = (match.index ?? 0) + match[0].length - 1
    const literal = balancedBraces(source, open)
    const tool = match[1] ?? ''
    const line = lineOf(source, match.index ?? 0)
    const text = `${tool}(${literal ?? source.slice(open, open + 60)}`.replace(/\s+/g, ' ')
    if (literal === undefined) {
      const evaluate = (): never => {
        throw new Error('braces never close')
      }
      return [{ file, line, text, tool, evaluate }]
    }
    return [{ file, line, text, tool, evaluate: () => evaluateLiteral(literal) }]
  })
}

// A JSON `tools/call` shape: `{ "name": "<tool>", "arguments": { ... } }`.
function jsonExamples(file: string, source: string): Example[] {
  return [...source.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((match) => {
    const block = match[1] ?? ''
    const named = new RegExp(`"name":\\s*"(${TOOL_NAME})"`).exec(block)
    if (!named) return []
    const line = lineOf(source, match.index ?? 0) + 1
    const text = `json ${named[1]} ${block}`.replace(/\s+/g, ' ')
    const evaluate = () => toPlainJson((JSON.parse(block) as { arguments?: unknown }).arguments)
    return [{ file, line, text, tool: named[1] ?? '', evaluate }]
  })
}

const EXAMPLES: readonly Example[] = SOURCES.flatMap((path) => {
  const source = readFileSync(path, 'utf8')
  const file = relative(ROOT, path)
  return [...callExamples(file, source), ...jsonExamples(file, source)]
})

/**
 * Examples that are deliberately not a whole call, with why. Guarded from both
 * sides: an entry matching no example, or one that now parses, fails as stale.
 * The key is `<file>::<the call, whitespace collapsed>`.
 */
const PARTIAL_EXAMPLES: Readonly<Record<string, string>> = {}

function problem(example: Example): string | undefined {
  const schema = INPUT_SCHEMAS.get(example.tool)
  if (!schema) return `no registered tool ${example.tool}`
  let args: unknown
  try {
    args = example.evaluate()
  } catch (error) {
    return `not evaluable: ${error instanceof Error ? error.message : String(error)}`
  }
  const result = schema.safeParse(args)
  if (result.success) return undefined
  return result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

const keyOf = (example: Example) => `${example.file}::${example.text}`

describe('tool-call examples in skills, README and docs', () => {
  // A scan that finds nothing passes. The surface holds more than twenty examples,
  // and a count far below that means the extractor stopped matching.
  it('finds the examples it is meant to hold', () => {
    expect(EXAMPLES.length).toBeGreaterThan(20)
    const tools = new Set(EXAMPLES.map((example) => example.tool))
    expect(tools.has('wb_canvas_edit')).toBe(true)
    expect(tools.has('wb_workspace_edit')).toBe(true)
    expect(tools.has('wb_scene_render')).toBe(true)
    expect(SOURCES.some((path) => path.endsWith('skills/drawing-visuals/SKILL.md'))).toBe(true)
  })

  it('refuses the flat edge shape the drawing skill once taught', () => {
    const flat = callExamples(
      'inline',
      'wb_canvas_edit({ workspaceId, documentId, ops: [{ op: "edge.add", edge: { fromNode: "a", toNode: "b" } }] })',
    )
    expect(flat).toHaveLength(1)
    expect(problem(flat[0] as Example)).toContain('Unrecognized keys')
  })

  // `nodes` on a region.set is a list of id strings. A skill that once taught
  // node objects with optional geometry sent every copy to a validation error.
  it('refuses node objects in a region.set, which names its members by id', () => {
    const [objects, ids] = ['{ id: "a" }', '"a"'].map((member) =>
      callExamples(
        'inline',
        `wb_canvas_edit({ workspaceId, documentId, ops: [{ op: "region.set", within: "g", nodes: [${member}] }] })`,
      ),
    )
    expect(problem(objects?.[0] as Example)).toContain('expected string')
    expect(problem(ids?.[0] as Example)).toBeUndefined()
  })

  it('holds a region.set example from the drawing skill', () => {
    expect(
      EXAMPLES.some(
        (example) =>
          example.file === 'skills/drawing-visuals/SKILL.md' && example.text.includes('region.set'),
      ),
    ).toBe(true)
  })

  it('every example is accepted by the input schema its tool registers', () => {
    const failures = EXAMPLES.filter((example) => !(keyOf(example) in PARTIAL_EXAMPLES)).flatMap(
      (example) => {
        const found = problem(example)
        return found ? [`${example.file}:${example.line} ${example.tool} -> ${found}`] : []
      },
    )
    expect(failures).toEqual([])
  })

  it('every partial-example entry still names an example that fails', () => {
    const live = new Map(EXAMPLES.map((example) => [keyOf(example), example]))
    const stale = Object.keys(PARTIAL_EXAMPLES).filter((key) => {
      const example = live.get(key)
      return example === undefined || problem(example) === undefined
    })
    expect(stale).toEqual([])
  })
})
