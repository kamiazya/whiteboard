import { describe, expect, test } from 'vitest'
import { canvasEditInputSchema } from './canvas-edit.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('wb_canvas_edit — an object nested inside an op refuses a key it does not declare', () => {
  // The top-level op objects are strict, and a nested model object that
  // stripped instead made the same mistake silent one level down: a comment's
  // invented field would be dropped with the call reporting success.
  const accepts = (op: Record<string, unknown>) =>
    canvasEditInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [op],
    }).success
  const addNode = (node: Record<string, unknown>) => ({
    op: 'node.add',
    node: { type: 'text', text: 'x', ...node },
  })

  test('a node facets bucket', () => {
    expect(accepts(addNode({ facets: { 'example.kanban/v1': { status: 'todo' } } }))).toBe(true)
    expect(accepts(addNode({ facets: { nope: {} } }))).toBe(false)
  })

  test('a comment draft', () => {
    const add = (comment: Record<string, unknown>) => ({
      op: 'comment.add',
      comment: { text: 'x', x: 5, y: 5, ...comment },
    })
    expect(accepts(add({}))).toBe(true)
    expect(accepts(add({ foo: 1 }))).toBe(false)
  })
})
