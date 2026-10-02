import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  readSpatialCanvas,
  readSpatialCanvasWithSkipped,
  reconcileSpatialCanvas,
  writeSpatialCanvas,
} from './loro-bridge.js'

const A = textNode({ id: 'a', text: 'alpha', x: 0, y: 0, width: 10, height: 10 })
const B = textNode({ id: 'b', text: 'beta', x: 50, y: 0, width: 10, height: 10 })
const point = (x: number, y: number) => ({ kind: 'point' as const, point: { x, y } })

/** A record a newer client wrote: valid today except for one field this schema does not know. */
function plantFromTheFuture(doc: LoroDoc): void {
  doc.getMap('nodes').set('future-node', { ...A, id: 'future-node', fieldFromTheFuture: 1 })
  doc.getMap('edges').set('future-edge', {
    id: 'future-edge',
    from: { node: 'a' },
    to: { node: 'b' },
    fieldFromTheFuture: 1,
  })
  doc.getMap('lines').set('future-line', {
    id: 'future-line',
    from: point(0, 0),
    to: point(1, 1),
    fieldFromTheFuture: 1,
  })
  doc.commit()
}

const ids = (doc: LoroDoc, map: 'nodes' | 'edges' | 'lines') =>
  Object.keys(doc.getMap(map).toJSON()).sort()

describe('readSpatialCanvasWithSkipped', () => {
  test('counts every node, edge and line the schema refused, and the canvas it answers is readSpatialCanvas', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [A, B], edges: [] })
    plantFromTheFuture(doc)

    const { canvas, skipped } = readSpatialCanvasWithSkipped(doc)

    expect(skipped).toBe(3)
    expect(canvas).toEqual(readSpatialCanvas(doc))
    expect(canvas.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])
  })

  test('is zero for a document every record of which parses', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [A],
      edges: [],
      lines: [{ id: 'l', from: point(0, 0), to: point(2, 2) }],
    })

    expect(readSpatialCanvasWithSkipped(doc).skipped).toBe(0)
  })
})

describe('reconcileSpatialCanvas over lines', () => {
  test('a line the caller drew is written, an unreadable one beside it stays', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [A, B], edges: [] })
    plantFromTheFuture(doc)
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, {
      ...prev,
      lines: [{ id: 'drawn', from: point(1, 1), to: point(9, 9) }],
    })

    expect(ids(doc, 'lines')).toEqual(['drawn', 'future-line'])
    expect(ids(doc, 'nodes')).toContain('future-node')
    expect(ids(doc, 'edges')).toContain('future-edge')
  })

  test('a line the caller could see and dropped is removed, and so is its lock', () => {
    const doc = new LoroDoc()
    const line = { id: 'l', from: point(0, 0), to: point(2, 2) }
    writeSpatialCanvas(doc, { nodes: [A], edges: [], lines: [line] })
    doc.getMap('edgeLocks').set('l', true)
    doc.commit()
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, { nodes: prev.nodes, edges: prev.edges })

    expect(ids(doc, 'lines')).toEqual([])
    expect(readSpatialCanvas(doc).lines).toBeUndefined()
    expect(Object.keys(doc.getMap('edgeLocks').toJSON())).toEqual([])
  })

  test('a changed line is rewritten and an identical one writes no op', () => {
    const doc = new LoroDoc()
    const line = { id: 'l', from: point(0, 0), to: point(2, 2) }
    writeSpatialCanvas(doc, { nodes: [A], edges: [], lines: [line] })
    const prev = readSpatialCanvas(doc)
    const before = doc.oplogVersion()

    reconcileSpatialCanvas(doc, prev, { ...prev, lines: [{ ...line }] })
    expect(doc.oplogVersion().compare(before)).toBe(0)

    reconcileSpatialCanvas(doc, prev, { ...prev, lines: [{ ...line, to: point(7, 7) }] })
    expect(readSpatialCanvas(doc).lines?.[0]?.to).toEqual(point(7, 7))
  })
})
