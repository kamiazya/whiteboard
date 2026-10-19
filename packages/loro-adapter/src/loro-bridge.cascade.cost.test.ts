import {
  type CanvasEdge,
  type CanvasLine,
  canvasEdgeSchema,
  canvasLineSchema,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readEdgeLocks,
  readNodeLocks,
  readSpatialCanvas,
  reconcileSpatialCanvas,
  setEdgeLock,
  setNodeLock,
  withSpatialBatch,
  writeSpatialCanvas,
} from './loro-bridge.js'

const NODES = 200
const ANCHORED_EDGES = 100
const FREE_LINES = 200
const ANCHORED_LINES = 50

function board(): SpatialCanvas {
  const nodes = Array.from({ length: NODES }, (_, i) =>
    textNode({ id: `n${i}`, text: `node ${i}`, x: i * 20, y: 0, width: 10, height: 10 }),
  )
  const edges: CanvasEdge[] = Array.from({ length: ANCHORED_EDGES }, (_, i) => ({
    id: `e${i}`,
    from: { node: `n${i}` },
    to: { node: `n${(i + 1) % NODES}` },
  }))
  const free: CanvasLine[] = Array.from({ length: FREE_LINES }, (_, i) => ({
    id: `free${i}`,
    from: { kind: 'point', point: { x: i, y: 0 } },
    to: { kind: 'point', point: { x: i, y: 10 } },
  }))
  const anchored: CanvasLine[] = Array.from({ length: ANCHORED_LINES }, (_, i) => ({
    id: `ink${i}`,
    from: { kind: 'node', node: `n${i}` },
    to: { kind: 'point', point: { x: i, y: 10 } },
  }))
  return { nodes, edges, lines: [...free, ...anchored] }
}

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, board())
  for (let i = 0; i < NODES; i += 10) setNodeLock(doc, `n${i}`, true)
  for (let i = 0; i < ANCHORED_EDGES; i += 10) setEdgeLock(doc, `e${i}`, true)
  setEdgeLock(doc, 'free0', true)
  setEdgeLock(doc, 'ink0', true)
  return doc
}

/** Counts every edge/line schema parse and every map key materialisation the body causes. */
function counting(body: () => void): { parses: number; keyReads: number } {
  const edgeParse = vi.spyOn(canvasEdgeSchema, 'safeParse')
  const lineParse = vi.spyOn(canvasLineSchema, 'safeParse')
  const keys = vi.spyOn(LoroMap.prototype, 'keys')
  body()
  return {
    parses: edgeParse.mock.calls.length + lineParse.mock.calls.length,
    keyReads: keys.mock.calls.length,
  }
}

function expectCascadeLanded(doc: LoroDoc): void {
  const after = readSpatialCanvas(doc)
  expect(after.nodes).toEqual([])
  expect(after.edges).toEqual([])
  // Every free line survives; every line anchored on a removed node is gone.
  expect((after.lines ?? []).map((line) => line.id).sort()).toEqual(
    Array.from({ length: FREE_LINES }, (_, i) => `free${i}`).sort(),
  )
  expect([...readNodeLocks(doc)]).toEqual([])
  expect([...readEdgeLocks(doc)]).toEqual(['free0'])
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Removing every node must sweep the edges and lines ONCE, not once per
 * removed node: per-node it was N x (E + L) schema parses and key reads,
 * synchronous under the workspace write lock.
 */
describe('a node cascade reads each edge and line once however many nodes it removes', () => {
  it('a reconcile to no nodes parses edges and lines at most once each', () => {
    const doc = seeded()
    const prev = readSpatialCanvas(doc)
    const next: SpatialCanvas = {
      nodes: [],
      edges: [],
      lines: (prev.lines ?? []).filter((line) => line.id.startsWith('free')),
    }

    const { parses, keyReads } = counting(() => reconcileSpatialCanvas(doc, prev, next))

    expectCascadeLanded(doc)
    expect(parses).toBeGreaterThan(0)
    expect(parses).toBeLessThanOrEqual(ANCHORED_EDGES + FREE_LINES + ANCHORED_LINES)
    expect(keyReads).toBeLessThanOrEqual(4)
  })

  it('a batch deleting every node parses edges and lines at most once each', () => {
    const doc = seeded()

    const { parses, keyReads } = counting(() =>
      withSpatialBatch(doc, (writer) => {
        for (let i = 0; i < NODES; i += 1) writer.deleteNode(`n${i}`)
      }),
    )

    expectCascadeLanded(doc)
    expect(parses).toBeGreaterThan(0)
    expect(parses).toBeLessThanOrEqual(ANCHORED_EDGES + FREE_LINES + ANCHORED_LINES)
    expect(keyReads).toBeLessThanOrEqual(4)
  })
})
