import {
  NODE_LOCATION_MAX_CHARS,
  nodeFileInputSchema,
  nodeSubpathInputSchema,
  nodeUrlInputSchema,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DOCUMENT_ID, WORKSPACE_ID } from './_test-canvas-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'

type Parsed = { success: boolean; error?: { issues: { message: string }[] } }

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as Parsed
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

const canvasBatch = (op: Record<string, unknown>) =>
  canvasEditInputSchema.safeParse({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops: [op],
  })

const box = { x: 0, y: 0, width: 200, height: 60 }
const urlOf = (length: number) => {
  const head = 'https://example.com/'
  return head + 'a'.repeat(length - head.length)
}
const fileOf = (length: number) => 'a'.repeat(length)
const subpathOf = (length: number) => `#${'a'.repeat(length - 1)}`

/** Every op that hands a node's location to the write path, with the schema that bounds it. */
const LOCATION_WRITERS: ReadonlyArray<
  readonly [string, (length: number) => string, z.ZodType, (value: string) => unknown]
> = [
  [
    'node.add (link) url',
    urlOf,
    nodeUrlInputSchema,
    (url) => canvasBatch({ op: 'node.add', node: { type: 'link', url, ...box } }),
  ],
  [
    'node.add (file) file',
    fileOf,
    nodeFileInputSchema,
    (file) => canvasBatch({ op: 'node.add', node: { type: 'file', file, ...box } }),
  ],
  [
    'node.add (file) subpath',
    subpathOf,
    nodeSubpathInputSchema,
    (subpath) =>
      canvasBatch({ op: 'node.add', node: { type: 'file', file: 'notes', subpath, ...box } }),
  ],
  [
    'node.patch url',
    urlOf,
    nodeUrlInputSchema,
    (url) => canvasBatch({ op: 'node.patch', id: 'n', patch: { url } }),
  ],
  [
    'node.patch file',
    fileOf,
    nodeFileInputSchema,
    (file) => canvasBatch({ op: 'node.patch', id: 'n', patch: { file } }),
  ],
  [
    'node.patch subpath',
    subpathOf,
    nodeSubpathInputSchema,
    (subpath) => canvasBatch({ op: 'node.patch', id: 'n', patch: { subpath } }),
  ],
]

describe('the size of a node location is declared once', () => {
  it.each(
    LOCATION_WRITERS,
  )('%s refuses one character past the limit, in the same words', (_op, of, schema, parse) => {
    const over = of(NODE_LOCATION_MAX_CHARS + 1)
    const expected = refusalMessages(schema.safeParse(over))
    expect(expected[0]).toMatch(/-character limit$/)
    expect(refusalMessages(parse(over))).toEqual(expected)
  })

  it.each(LOCATION_WRITERS)('%s accepts one of exactly the limit', (_op, of, _schema, parse) => {
    expect((parse(of(NODE_LOCATION_MAX_CHARS)) as Parsed).success).toBe(true)
  })

  it('publishes the limit as maxLength on every field that carries a location', () => {
    const published = JSON.stringify(z.toJSONSchema(canvasEditInputSchema, { io: 'input' }))
    const bounded = (field: string) =>
      published.match(new RegExp(`"${field}":\\{[^{}]*"maxLength":${NODE_LOCATION_MAX_CHARS}`, 'g'))
        ?.length ?? 0
    // One on node.add's arm and one on node.patch, for each field.
    expect(bounded('url')).toBe(2)
    expect(bounded('file')).toBe(2)
    expect(bounded('subpath')).toBe(2)
  })
})
