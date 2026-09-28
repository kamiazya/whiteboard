/**
 * The inspector is ABOUT one object, and a write from it reaches the
 * selection that object belongs to. These are the rules the panel's two
 * write paths share, stated where both can be read at once.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import {
  facetWriteCommands,
  inspectorSubject,
  tagWriteCommands,
  writeReachesIds,
} from './selection-inspector.js'

const node = (id: string, tags?: string[]) =>
  textNode({ id, x: 0, y: 0, width: 10, height: 10, text: id, ...(tags ? { tags } : {}) })

const canvas: SpatialCanvas = {
  nodes: [node('a', ['draft']), node('b', ['draft', 'mine']), node('c')],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' }, tags: ['link'] }],
}

describe('what the inspector is about', () => {
  it('is the selected edge when there is one, since selecting an edge clears the node', () => {
    expect(inspectorSubject(canvas, 'a', 'e1')).toEqual({ kind: 'edge', edge: canvas.edges[0] })
  })

  it('is the selected node otherwise, and nothing when nothing is selected', () => {
    expect(inspectorSubject(canvas, 'a', null)).toEqual({ kind: 'node', node: canvas.nodes[0] })
    expect(inspectorSubject(canvas, null, null)).toBeUndefined()
    expect(inspectorSubject(canvas, 'gone', null)).toBeUndefined()
  })
})

describe('where a write reaches', () => {
  it('a member of the selection reaches the whole selection', () => {
    expect(writeReachesIds({ id: 'a' }, 'a', new Set(['b']))).toEqual(['a', 'b'])
  })

  it('a node outside the selection reaches that node alone', () => {
    expect(writeReachesIds({ id: 'c' }, 'a', new Set(['b']))).toEqual(['c'])
  })

  it('a facet write on a node follows the same rule', () => {
    const subject = { kind: 'node' as const, node: canvas.nodes[0]! }
    expect(facetWriteCommands(subject, 'a', new Set(['b']), 'k', 1)).toEqual([
      { kind: 'set-node-facet', id: 'a', key: 'k', payload: 1 },
      { kind: 'set-node-facet', id: 'b', key: 'k', payload: 1 },
    ])
  })

  it('a facet write on an edge reaches that one edge', () => {
    const subject = { kind: 'edge' as const, edge: canvas.edges[0]! }
    expect(facetWriteCommands(subject, 'a', new Set(['b']), 'k', 1)).toEqual([
      { kind: 'set-edge-facet', id: 'e1', key: 'k', payload: 1 },
    ])
  })
})

describe('a tag change', () => {
  it('applies the CHANGE to each member, keeping the tags only that member carries', () => {
    const subject = { kind: 'node' as const, node: canvas.nodes[0]! }
    // The row showed ['draft'] and the person made it ['draft', 'ok'].
    expect(tagWriteCommands(canvas, subject, 'a', new Set(['b']), ['draft', 'ok'])).toEqual([
      { kind: 'set-node-tags', id: 'a', tags: ['draft', 'ok'] },
      { kind: 'set-node-tags', id: 'b', tags: ['draft', 'mine', 'ok'] },
    ])
  })

  it('reads the tags as the eager chain holds them, not as the row last showed them', () => {
    const subject = { kind: 'node' as const, node: canvas.nodes[0]! }
    const committed: SpatialCanvas = {
      ...canvas,
      nodes: [node('a', ['draft', 'landed']), ...canvas.nodes.slice(1)],
    }
    expect(tagWriteCommands(committed, subject, 'a', new Set(), [])).toEqual([
      { kind: 'set-node-tags', id: 'a', tags: ['landed'] },
    ])
  })

  it('on an edge, changes that edge', () => {
    const subject = { kind: 'edge' as const, edge: canvas.edges[0]! }
    expect(tagWriteCommands(canvas, subject, 'a', new Set(['b']), [])).toEqual([
      { kind: 'set-edge-tags', id: 'e1', tags: [] },
    ])
  })
})
