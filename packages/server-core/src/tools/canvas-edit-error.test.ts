import { spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { describeIssues } from './canvas-edit-error.js'

// A refusal is the only text a model repairs a batch from, so none may carry
// an unformatted object or a fragment of the code that formats it.
const SOURCE_LEAK = /\[object Object\]|\.map\(/

describe('describeIssues', () => {
  test('qualifies each issue with the field path it is about', () => {
    const parsed = spatialCanvasSchema.safeParse({
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' })],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'ghost' } }],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const text = describeIssues(parsed.error)
    expect(text).toContain('edges.0.to.node: ')
    expect(text).toContain('"ghost"')
    expect(text).not.toMatch(SOURCE_LEAK)
  })
})

describe('wb_canvas_edit whole-canvas refusal', () => {
  test('names the element at fault when a stored canvas the batch left alone is invalid', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
      edges: [{ id: 'dangling', from: { node: 'a' }, to: { node: 'ghost' } }],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    const refusal = await tool
      .execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'a', patch: { text: 'edited' } }],
      })
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )

    expect(refusal).toMatch(/the resulting canvas is not valid: .*dangling.*ghost/)
    expect(refusal).not.toMatch(SOURCE_LEAK)
  })
})
