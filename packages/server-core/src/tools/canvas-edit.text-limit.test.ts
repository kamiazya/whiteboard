import {
  NODE_TEXT_MAX_CHARS,
  nodeText,
  nodeTextInputSchema,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'

const overLimit = 'x'.repeat(NODE_TEXT_MAX_CHARS + 1)
const atLimit = 'x'.repeat(NODE_TEXT_MAX_CHARS)
const REFUSAL = /character limit for one node/

const batch = (op: Record<string, unknown>) =>
  canvasEditInputSchema.safeParse({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops: [op],
  })

/** Every op that hands a text node's text to the write path. */
const WRITERS: ReadonlyArray<readonly [string, (text: string) => unknown]> = [
  [
    'node.add',
    (text) => batch({ op: 'node.add', node: { type: 'text', text, width: 200, height: 100 } }),
  ],
  ['node.patch', (text) => batch({ op: 'node.patch', id: 'a', patch: { text } })],
  [
    'node.splice',
    (text) => batch({ op: 'node.splice', id: 'a', startLine: 0, endLine: 0, replacement: text }),
  ],
]

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as { success: boolean; error?: { issues: { message: string }[] } }
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

describe('the size of one text node is declared once', () => {
  it.each(WRITERS)('%s refuses one character past the limit, in the same words', (_op, parse) => {
    const expected = refusalMessages(nodeTextInputSchema.safeParse(overLimit))
    expect(expected[0]).toMatch(REFUSAL)
    expect(refusalMessages(parse(overLimit))).toEqual(expected)
  })

  it.each(WRITERS)('%s accepts text of exactly the limit', (_op, parse) => {
    expect((parse(atLimit) as { success: boolean }).success).toBe(true)
  })
})

async function spliceInto(stored: string, replacement: string) {
  const store = new FakeDocumentStore()
  await seedCanvas(store, {
    nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 100, text: stored })],
    edges: [],
  })
  await createCanvasEditTool(makeDeps(store)).execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops: [{ op: 'node.splice', id: 'a', startLine: 1, endLine: 1, replacement }],
  })
  const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
  return canvas.nodes[0] as SpatialNode
}

describe('a splice is held to the limit by what it leaves', () => {
  it('refuses a splice that grows the text past the limit', async () => {
    const stored = `${'x'.repeat(NODE_TEXT_MAX_CHARS - 10)}\nshort`
    await expect(spliceInto(stored, 'y'.repeat(100))).rejects.toThrow(REFUSAL)
  })

  // A node written before the limit stays editable toward it, which a flat
  // length test on the result would forbid.
  it('applies a splice that shrinks text already over the limit', async () => {
    const stored = `${'x'.repeat(NODE_TEXT_MAX_CHARS + 50)}\nthe second line`
    const node = await spliceInto(stored, 'two')
    expect(nodeText(node)).toBe(`${'x'.repeat(NODE_TEXT_MAX_CHARS + 50)}\ntwo`)
  })
})
