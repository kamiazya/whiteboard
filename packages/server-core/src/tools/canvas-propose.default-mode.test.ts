// The default mode of `wb_canvas_edit` stores a batch as a proposal exactly
// when every op in it could be proposed. What the tool's description says
// applies "whatever the mode" must be what applies, op by op.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import type { CanvasEditInput } from './canvas-edit-ops.js'
import { isProposableOp } from './canvas-propose.js'

type Op = CanvasEditInput['ops'][number]

const POINT_LINE = {
  id: 'l',
  from: { kind: 'point', point: { x: 0, y: 0 } },
  to: { kind: 'point', point: { x: 9, y: 9 } },
} as const

const BOARD: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 200, height: 80, text: 'one\ntwo\nthree' }),
    textNode({ id: 'b', x: 400, y: 0, width: 100, height: 40, text: 'B' }),
    groupNode({ id: 'g', x: 0, y: 300, width: 400, height: 300, label: 'G' }),
  ],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
  lines: [POINT_LINE],
  comments: [{ id: 'c', x: 5, y: 5, text: 'hm', createdAt: '2026-01-01T00:00:00.000Z' }],
}

/**
 * One valid op per verb, typed as a record over the verb union so a verb
 * added to the schema without a row here is a compile error rather than a
 * verb this table never reaches.
 */
const ONE_OF_EACH: { [K in Op['op']]: Extract<Op, { op: K }> } = {
  'node.add': { op: 'node.add', node: { id: 'n2', type: 'text', text: 'new' } },
  'node.patch': { op: 'node.patch', id: 'a', patch: { text: 'edited' } },
  'node.splice': { op: 'node.splice', id: 'a', startLine: 1, endLine: 1, replacement: 'TWO' },
  'node.remove': { op: 'node.remove', id: 'b' },
  'edge.add': { op: 'edge.add', edge: { id: 'e2', from: { node: 'b' }, to: { node: 'a' } } },
  'edge.patch': { op: 'edge.patch', id: 'e', patch: { label: 'x' } },
  'edge.remove': { op: 'edge.remove', id: 'e' },
  'line.add': { op: 'line.add', line: { ...POINT_LINE, id: 'l2' } },
  'line.patch': { op: 'line.patch', id: 'l', patch: { label: 'x' } },
  'line.remove': { op: 'line.remove', id: 'l' },
  'node.lock': { op: 'node.lock', id: 'a', locked: true },
  'edge.lock': { op: 'edge.lock', id: 'e', locked: true },
  tidy: { op: 'tidy' },
  'comment.add': { op: 'comment.add', comment: { x: 1, y: 1, text: 'new' } },
  'comment.resolve': { op: 'comment.resolve', id: 'c' },
  'region.set': { op: 'region.set', within: 'g', nodes: [] },
}

describe('wb_canvas_edit default mode, op by op', () => {
  test('covers every verb the tool accepts', () => {
    expect(Object.keys(ONE_OF_EACH).length).toBeGreaterThan(15)
  })

  test.each(
    Object.values(ONE_OF_EACH),
  )('$op is proposed exactly when it is proposable', async (op) => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)

    const result = await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [op],
    })

    expect(result.proposed !== undefined).toBe(isProposableOp(op.op))
    expect(result.applied).toBe(result.proposed === undefined ? 1 : 0)
  })

  test('the proposable verbs are the content ones, a splice included', () => {
    const proposable = Object.keys(ONE_OF_EACH).filter(isProposableOp).sort()
    expect(proposable).toEqual([
      'edge.add',
      'edge.patch',
      'edge.remove',
      'line.add',
      'line.patch',
      'line.remove',
      'node.add',
      'node.patch',
      'node.remove',
      'node.splice',
    ])
  })

  test('a splice is stored as the patch of text it comes to', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)

    const result = await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      ops: [ONE_OF_EACH['node.splice']],
    })

    expect(result.proposed?.changes).toEqual([
      {
        id: 'node:a',
        status: 'open',
        op: 'node.patch',
        nodeId: 'a',
        patch: { text: 'one\nTWO\nthree' },
        assumed: { text: 'one\ntwo\nthree' },
      },
    ])
    expect(result.snapshot.nodes.find((node) => node.id === 'a')).toMatchObject({
      text: 'one\ntwo\nthree',
    })
  })

  test('an explicit propose accepts a splice', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)

    const result = await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'propose',
      ops: [ONE_OF_EACH['node.splice']],
    })

    expect(result.proposed?.changes).toHaveLength(1)
  })
})

describe('the tool description', () => {
  test('names every verb family a batch applies directly whatever the mode', () => {
    const { description } = createCanvasEditTool(makeDeps(new FakeDocumentStore()))
    const direct = Object.keys(ONE_OF_EACH).filter((op) => !isProposableOp(op))
    // Families, as the description words them: comment.* -> comments, *.lock -> locks.
    const families = new Set(
      direct.map((op) =>
        op.startsWith('comment.') ? 'comments' : op.endsWith('.lock') ? 'locks' : op,
      ),
    )
    expect([...families].sort()).toEqual(['comments', 'locks', 'region.set', 'tidy'])
    for (const family of families) expect(description).toContain(family)
    expect(description).not.toContain('splice')
  })
})
