import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readSpatialCanvas } from './loro-bridge.js'

/**
 * A record written before [ADR-0033](../../../docs/contributing/adr/0033-model-and-format.md)
 * stored the canvas's facets, a node's facets and embed, and an edge's facets
 * under the FORMAT's extension key, because the model was the format. These
 * seed that shape by hand — the literal is the shape as it stood, the way a
 * migration's own text always is — and assert the read lifts it.
 *
 * Nothing else would say so. The model is `.strict()` now, so a stored node
 * still carrying the old key fails its schema and `readSpatialCanvas` drops
 * it: the node VANISHES rather than losing a field, and no test that asserts
 * on a freshly written document can see that.
 */
function docWithLegacyShape(): LoroDoc {
  const doc = new LoroDoc()
  doc.getMap('nodes').set('n1', {
    id: 'n1',
    type: 'text',
    text: 'hi',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    'x-whiteboard': {
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
    },
  })
  doc.getMap('nodes').set('n2', {
    id: 'n2',
    type: 'text',
    text: 'there',
    x: 50,
    y: 50,
    width: 10,
    height: 10,
    'x-whiteboard': { facets: { 'visual.text/v0': { align: 'center' } } },
  })
  doc.getMap('edges').set('e1', {
    id: 'e1',
    from: { kind: 'node' as const, node: 'n1' },
    to: { kind: 'node' as const, node: 'n2' },
    'x-whiteboard': { facets: { 'visual.edges/v0': { routing: 'curved' } } },
  })
  doc.getMap('canvas').set('x-whiteboard', {
    facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
  })
  return doc
}

describe('a record written under the pre-ADR-0033 extension key still reads', () => {
  const canvas = readSpatialCanvas(docWithLegacyShape() as never)

  it('keeps both nodes rather than dropping the ones carrying the old key', () => {
    expect(canvas.nodes.map((node) => node.id)).toEqual(['n1', 'n2'])
  })

  it("lifts a node's embed out of the extension's embed arm", () => {
    expect(canvas.nodes[0]?.embed).toEqual({ documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' })
  })

  it("lifts a node's facets, with or without an embed beside them", () => {
    expect(canvas.nodes[0]?.facets).toEqual({ 'visual.shape/v0': { kind: 'hexagon' } })
    expect(canvas.nodes[1]?.facets).toEqual({ 'visual.text/v0': { align: 'center' } })
  })

  it("lifts an edge's facets", () => {
    expect(canvas.edges[0]?.facets).toEqual({ 'visual.edges/v0': { routing: 'curved' } })
  })

  it("lifts the canvas's own facets, which is where a board's theme lives", () => {
    expect(canvas.facets).toEqual({ 'visual.theme/v0': { theme: 'visual.sketch' } })
  })
})
