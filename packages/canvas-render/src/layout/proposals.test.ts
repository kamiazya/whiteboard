// Drawing a proposal on the document a person is already looking at
// (ADR-0029 decision 1). No second document and no lane to switch to: the
// change is outlined where it would land, and one bubble per proposal says
// what it would do. Composed after nodes and edges, like the comment layer,
// so it paints above content on every surface with no per-surface wiring.
import type { Proposal, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { ResolvedEdgeNode, SceneNode, ShapeSceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const measure = createFakeMeasure()

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
  resolveProposal: () => ({
    outline: { fill: 'none', stroke: '#4f46e5', strokeWidth: 2, strokeDasharray: '6 4' },
    bubble: { fill: '#ffffff', stroke: '#4f46e5' },
    leader: { stroke: '#4f46e5', strokeWidth: 1, strokeDasharray: '4 3' },
  }),
}

const NODE_A = { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'A' } as const
const NODE_B = { id: 'b', type: 'text', x: 300, y: 0, width: 100, height: 40, text: 'B' } as const
const BOARD: SpatialCanvas = {
  nodes: [NODE_A, NODE_B],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
}

function layout(canvas: SpatialCanvas, proposals: readonly Proposal[]): readonly SceneNode[] {
  const options: SpatialLayoutOptions = {
    measure,
    appearance,
    parseBody: (text) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    proposals,
  }
  return layoutSpatialCanvas(canvas, options).nodes
}

const shapeById = (nodes: readonly SceneNode[], id: string): ShapeSceneNode | undefined =>
  nodes.find((node): node is ShapeSceneNode => node.kind === 'shape' && node.id === id)

const edgeById = (nodes: readonly SceneNode[], id: string): ResolvedEdgeNode | undefined =>
  nodes.find((node): node is ResolvedEdgeNode => node.kind === 'edge' && node.id === id)

/** The bubble's words, wherever the mdast pipeline put them. */
function wordsOf(nodes: readonly SceneNode[]): string {
  return nodes
    .flatMap((node): TextRunNode[] => {
      if (node.kind === 'textRun') return [node]
      if (node.kind === 'paragraph' || node.kind === 'heading') return [...node.runs]
      return []
    })
    .map((run) => run.text)
    .join(' ')
}

function proposalOf(changes: Proposal['changes']): Proposal {
  return { id: 'p1', createdAt: '2026-09-06T00:00:00.000Z', changes }
}

describe('drawing a proposal in place', () => {
  it('draws nothing at all when there is no proposal', () => {
    const bare = layout(BOARD, [])
    expect(bare.filter((node) => node.kind === 'shape' && node.proposalChrome === true)).toEqual([])
  })

  // An addition is outlined where it WOULD be, which is why the change
  // carries a resolved node: the box comes from the proposal, not from
  // anything already on the board.
  it('outlines a proposed addition at the box it would occupy', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        {
          id: 'node:c',
          status: 'open',
          op: 'node.add',
          node: { id: 'c', type: 'text', x: 500, y: 200, width: 120, height: 60, text: 'C' },
        },
      ]),
    ])
    expect(shapeById(nodes, 'node:c/outline')?.bbox).toEqual({ x: 500, y: 200, w: 120, h: 60 })
    // and the board itself did not gain the node
    expect(shapeById(nodes, 'c')).toBeUndefined()
  })

  // A patch is outlined where the element would END UP, not where it is: the
  // node stays drawn in place, and the outline is what says "there".
  it('outlines a proposed move at its destination, leaving the node where it is', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        {
          id: 'node:a',
          status: 'open',
          op: 'node.patch',
          nodeId: 'a',
          patch: { x: 600, y: 400 },
          assumed: { x: 0, y: 0 },
        },
      ]),
    ])
    expect(shapeById(nodes, 'node:a/outline')?.bbox).toEqual({ x: 600, y: 400, w: 100, h: 40 })
    expect(shapeById(nodes, 'a')?.bbox).toEqual({ x: 0, y: 0, w: 100, h: 40 })
  })

  it('outlines a proposed removal around the element it would delete', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        { id: 'node:b', status: 'open', op: 'node.remove', nodeId: 'b', assumed: NODE_B },
      ]),
    ])
    expect(shapeById(nodes, 'node:b/outline')?.bbox).toEqual({ x: 300, y: 0, w: 100, h: 40 })
  })

  // An edge has a route rather than a box, so its chrome traces the route.
  it('traces the route of an edge a proposal would remove', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        {
          id: 'edge:e',
          status: 'open',
          op: 'edge.remove',
          edgeId: 'e',
          assumed: { id: 'e', fromNode: 'a', toNode: 'b' },
        },
      ]),
    ])
    const traced = edgeById(nodes, 'edge:e/outline')
    expect(traced?.path).toEqual(edgeById(nodes, 'e')?.path)
  })

  it('draws a proposed edge between the nodes it would connect', () => {
    const nodes = layout({ nodes: [NODE_A, NODE_B], edges: [] }, [
      proposalOf([
        {
          id: 'edge:new',
          status: 'open',
          op: 'edge.add',
          edge: { id: 'new', fromNode: 'a', toNode: 'b' },
        },
      ]),
    ])
    const drawn = edgeById(nodes, 'edge:new/outline')
    expect(drawn?.path.length).toBeGreaterThanOrEqual(2)
  })

  // Decision 4's default control is the whole proposal, so the bubble counts
  // changes rather than repeating one per change.
  it('gives the proposal one bubble that counts what it would do', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        { id: 'node:b', status: 'open', op: 'node.remove', nodeId: 'b', assumed: NODE_B },
        {
          id: 'node:a',
          status: 'open',
          op: 'node.patch',
          nodeId: 'a',
          patch: { x: 600 },
          assumed: { x: 0 },
        },
      ]),
    ])
    expect(shapeById(nodes, 'p1/bubble')).toBeDefined()
    expect(edgeById(nodes, 'p1/leader')).toBeDefined()
    expect(wordsOf(nodes)).toContain('2 proposed changes')
  })

  // Decision 5: a conflict is MARKED for the person to judge, at the place
  // the judging happens. Nothing is decided on their behalf.
  it('says so on the bubble when a change no longer fits', () => {
    const moved: SpatialCanvas = { ...BOARD, nodes: [{ ...NODE_A, x: 55 }, NODE_B] }
    const nodes = layout(moved, [
      proposalOf([
        {
          id: 'node:a',
          status: 'open',
          op: 'node.patch',
          nodeId: 'a',
          patch: { x: 600 },
          assumed: { x: 0 },
        },
      ]),
    ])
    expect(wordsOf(nodes)).toContain('needs a look')
  })

  // A decided change is history, not something still asking to be drawn.
  it('draws nothing for a change that was already adopted or dismissed', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        { id: 'node:b', status: 'adopted', op: 'node.remove', nodeId: 'b', assumed: NODE_B },
      ]),
    ])
    expect(shapeById(nodes, 'node:b/outline')).toBeUndefined()
    expect(shapeById(nodes, 'p1/bubble')).toBeUndefined()
  })

  // The same rule the comment layer keeps: chrome carries an id for
  // hit-testing, and a marker so `sceneDigest` does not mistake it for an
  // addressable node.
  it('marks its chrome so the digest can tell it from content', () => {
    const nodes = layout(BOARD, [
      proposalOf([
        { id: 'node:b', status: 'open', op: 'node.remove', nodeId: 'b', assumed: NODE_B },
      ]),
    ])
    expect(shapeById(nodes, 'node:b/outline')?.proposalChrome).toBe(true)
    expect(shapeById(nodes, 'p1/bubble')?.proposalChrome).toBe(true)
  })
})
