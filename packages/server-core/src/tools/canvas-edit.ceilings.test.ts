import {
  CANVAS_MAX_EDGES_AND_LINES,
  CANVAS_MAX_NODES,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'

const box = (i: number): SpatialNode =>
  textNode({
    id: `n${i}`,
    x: (i % 40) * 120,
    y: Math.floor(i / 40) * 80,
    width: 100,
    height: 40,
    text: `n${i}`,
  })

async function editOn(nodes: readonly SpatialNode[], edges: number, ops: unknown[], lines = 0) {
  const store = new FakeDocumentStore()
  await seedCanvas(store, {
    nodes: [...nodes],
    edges: Array.from({ length: edges }, (_, i) => ({
      id: `e${i}`,
      from: { node: 'n0' },
      to: { node: 'n1' },
    })),
    ...(lines > 0 && {
      lines: Array.from({ length: lines }, (_, i) => ({
        id: `l${i}`,
        from: { kind: 'node' as const, node: 'n0' },
        to: { kind: 'point' as const, point: { x: 500, y: 500 } },
      })),
    }),
  })
  return createCanvasEditTool(makeDeps(store)).execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops,
  } as never)
}

const nodesOf = (count: number) => Array.from({ length: count }, (_, i) => box(i))
const addNode = (id: string) => ({
  op: 'node.add',
  node: { id, type: 'text', text: 'x', x: 0, y: 5000, width: 200, height: 80 },
})

describe('wb_canvas_edit tidies at most once per batch', () => {
  test('a second tidy is refused by name, and nothing is written', async () => {
    await expect(editOn(nodesOf(3), 0, [{ op: 'tidy' }, { op: 'tidy' }])).rejects.toThrow(
      /ops\[1\] \(tidy\) could not be applied: a batch tidies at most once/,
    )
  })

  test('one tidy still applies', async () => {
    const result = await editOn(nodesOf(3), 0, [{ op: 'tidy' }])
    expect(result.applied).toBe(1)
  })
})

describe('wb_canvas_edit holds the per-canvas node and edge ceilings', () => {
  test('a node.add that would take the canvas past the node ceiling names it', async () => {
    await expect(editOn(nodesOf(CANVAS_MAX_NODES), 0, [addNode('extra')])).rejects.toThrow(
      new RegExp(`ops\\[0\\] \\(node.add\\).*${CANVAS_MAX_NODES}-node limit for one canvas`),
    )
  })

  const addEdge = {
    op: 'edge.add',
    edge: { id: 'extra', from: { node: 'n1' }, to: { node: 'n0' } },
  }
  const addLine = {
    op: 'line.add',
    line: {
      id: 'extra',
      from: { kind: 'node', node: 'n1' },
      to: { kind: 'point', point: { x: 900, y: 900 } },
    },
  }
  const pastEdgesAndLines = (op: string) =>
    new RegExp(
      `ops\\[0\\] \\(${op}\\).*${CANVAS_MAX_EDGES_AND_LINES + 1} edges and lines, past the limit of ${CANVAS_MAX_EDGES_AND_LINES} edges and lines together for one canvas`,
    )

  test('an edge.add that would take the canvas past the edge ceiling names it', async () => {
    await expect(editOn(nodesOf(2), CANVAS_MAX_EDGES_AND_LINES, [addEdge])).rejects.toThrow(
      pastEdgesAndLines('edge.add'),
    )
  })

  test('a line.add counts against the same ceiling as the edges', async () => {
    await expect(editOn(nodesOf(2), CANVAS_MAX_EDGES_AND_LINES, [addLine])).rejects.toThrow(
      pastEdgesAndLines('line.add'),
    )
  })

  test('an edge.add onto a board whose lines fill the ceiling is refused', async () => {
    await expect(editOn(nodesOf(2), 0, [addEdge], CANVAS_MAX_EDGES_AND_LINES)).rejects.toThrow(
      pastEdgesAndLines('edge.add'),
    )
  })

  test('a canvas already past the node ceiling still takes an edit that adds nothing', async () => {
    const past = nodesOf(CANVAS_MAX_NODES + 1)
    const result = await editOn(past, 0, [
      { op: 'node.remove', id: 'n0' },
      addNode('replacement'),
      { op: 'node.patch', id: 'n2', patch: { x: 7 } },
    ])
    expect(result.applied).toBe(3)
  })

  test('the input refuses a tidy scope or region list longer than a canvas can hold', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `n${i}`)
    const parse = (op: unknown) =>
      canvasEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [op],
      })
    expect(parse({ op: 'tidy', scope: ids(CANVAS_MAX_NODES) }).success).toBe(true)
    expect(parse({ op: 'tidy', scope: ids(CANVAS_MAX_NODES + 1) }).success).toBe(false)
    expect(parse({ op: 'region.set', within: 'g', nodes: ids(CANVAS_MAX_NODES + 1) }).success).toBe(
      false,
    )
    expect(
      parse({
        op: 'region.set',
        within: 'g',
        nodes: [],
        edges: ids(CANVAS_MAX_EDGES_AND_LINES + 1),
      }).success,
    ).toBe(false)
  })
})

describe('wb_canvas_edit bounds what one batch places inside groups', () => {
  const MOVED = CANVAS_MAX_NODES / 2 + 100
  const group = (id: string, x: number) =>
    groupNode({ id, x, y: 0, width: 300, height: 300, label: id })
  const board = () => [group('g1', -1000), group('g2', -2000), ...nodesOf(MOVED)]
  const members = Array.from({ length: MOVED }, (_, i) => `n${i}`)
  const into = (within: string) => ({ op: 'region.set', within, nodes: members })

  test('one region.set moving every member in still applies', async () => {
    const result = await editOn(board(), 0, [into('g1')])
    expect(result.applied).toBe(1)
  })

  test('moving the same members on to a second group is refused by name', async () => {
    await expect(editOn(board(), 0, [into('g1'), into('g2')])).rejects.toThrow(
      new RegExp(
        `ops\\[1\\] \\(region.set\\) could not be applied: .*places at most ${CANVAS_MAX_NODES} nodes inside groups`,
      ),
    )
  })
})
