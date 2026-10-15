/**
 * Adopting a patch touches the element it names and nothing else.
 *
 * Every patch arm maps over a whole collection and picks its target by id, so
 * an arm that lost its id test would rewrite every node, edge or line on the
 * board — and a board holding ONE of each cannot tell the two apart. Hence a
 * property over boards that always carry several of every kind, with the
 * target drawn from anywhere in them.
 */
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import type { SpatialProposedChange } from './proposal.js'
import { applyCanvasChange } from './proposal-apply.js'
import type { CanvasEdge, CanvasLine, SpatialCanvas } from './spatial.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const ids = fc.uniqueArray(fc.stringMatching(/^[a-f]{1,3}$/), { minLength: 2, maxLength: 5 })

const boardOf = (
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  lineIds: readonly string[],
): SpatialCanvas => {
  const from = nodeIds[0] as string
  const to = nodeIds[nodeIds.length - 1] as string
  return {
    nodes: nodeIds.map((id, i) =>
      textNode({ id, x: i * 200, y: 0, width: 100, height: 40, text: id }),
    ),
    edges: edgeIds.map((id): CanvasEdge => ({ id, from: { node: from }, to: { node: to } })),
    lines: lineIds.map(
      (id): CanvasLine => ({
        id,
        from: { kind: 'point', point: { x: 0, y: 0 } },
        to: { kind: 'point', point: { x: 10, y: 0 } },
      }),
    ),
  }
}

type Kind = 'nodes' | 'edges' | 'lines'

const patchOf = (kind: Kind, id: string): SpatialProposedChange => {
  switch (kind) {
    case 'nodes':
      return {
        id: 'x',
        status: 'open',
        op: 'node.patch',
        nodeId: id,
        patch: { color: '3' },
        assumed: {},
      }
    case 'edges':
      return {
        id: 'x',
        status: 'open',
        op: 'edge.patch',
        edgeId: id,
        patch: { color: '3' },
        assumed: {},
      }
    case 'lines':
      return {
        id: 'x',
        status: 'open',
        op: 'line.patch',
        lineId: id,
        patch: { color: '3' },
        assumed: {},
      }
  }
}

const elementsOf = (canvas: SpatialCanvas, kind: Kind): readonly { readonly id: string }[] =>
  canvas[kind] ?? []

describe('adopting a patch', () => {
  fcTest.prop(
    [ids, ids, ids, fc.constantFrom<Kind>('nodes', 'edges', 'lines'), fc.nat()],
    withDefaults(),
  )(
    'changes the element it names and leaves every other one as it was',
    (nodeIds, edgeIds, lineIds, kind, pick) => {
      const board = boardOf(nodeIds, edgeIds, lineIds)
      const candidates = elementsOf(board, kind)
      const target = (candidates[pick % candidates.length] as { readonly id: string }).id
      const adopted = applyCanvasChange(board, patchOf(kind, target))

      for (const other of ['nodes', 'edges', 'lines'] as const) {
        const before = elementsOf(board, other)
        const after = elementsOf(adopted, other)
        expect(after.map((element) => element.id)).toEqual(before.map((element) => element.id))
        after.forEach((element, i) => {
          if (other === kind && element.id === target) {
            expect(element).toEqual({ ...before[i], color: '3' })
          } else {
            expect(element).toEqual(before[i])
          }
        })
      }
    },
  )
})
