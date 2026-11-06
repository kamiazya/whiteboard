import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeDocumentKind } from './document-envelope.js'
import { readSpatialCanvas } from './loro-bridge.js'
import { RetiredStoredShapeError, retiredStoredShapeIn } from './retired-stored-shape.js'

/**
 * Shapes an older version stored and no reader serves any more. Each is
 * seeded by hand — the literal is the shape as it stood, the way a
 * migration's own text always is — and each must be REFUSED by name: the
 * model is `.strict()`, so without the refusal a node still in an old shape
 * fails its schema and the canvas opens without it, with no word said.
 */
const BOX = { x: 0, y: 0, width: 10, height: 10 }
const CURRENT_NODE = {
  id: 'ok',
  ...BOX,
  resource: { mimeType: 'text/markdown', content: 'current' },
}

function docWith(seed: (doc: LoroDoc) => void): LoroDoc {
  const doc = new LoroDoc()
  doc.getMap('nodes').set('ok', CURRENT_NODE)
  seed(doc)
  doc.commit()
  return doc
}

const RETIRED: ReadonlyArray<{ name: string; seed: (doc: LoroDoc) => void; found: RegExp }> = [
  {
    name: "a node's facets and embed under the pre-ADR-0037 x-whiteboard key",
    seed: (doc) =>
      doc.getMap('nodes').set('n1', {
        id: 'n1',
        ...BOX,
        resource: { mimeType: 'text/markdown', content: 'hi' },
        'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
      }),
    found: /node "n1".*x-whiteboard/,
  },
  {
    name: "an edge's facets under the pre-ADR-0037 x-whiteboard key",
    seed: (doc) =>
      doc.getMap('edges').set('e1', {
        id: 'e1',
        from: { node: 'ok' },
        to: { node: 'ok' },
        'x-whiteboard': { facets: { 'visual.edges/v0': { routing: 'curved' } } },
      }),
    found: /edge "e1".*x-whiteboard/,
  },
  {
    name: "the canvas's facets under the pre-ADR-0037 x-whiteboard key",
    seed: (doc) =>
      doc
        .getMap('canvas')
        .set('x-whiteboard', { facets: { 'visual.theme/v0': { theme: 'visual.sketch' } } }),
    found: /canvas.*x-whiteboard/,
  },
  {
    name: 'a node in the pre-ADR-0038 node-kind union',
    seed: (doc) => doc.getMap('nodes').set('n2', { id: 'n2', type: 'text', text: 'hi', ...BOX }),
    found: /node "n2".*type "text"/,
  },
  {
    name: 'a group in the pre-ADR-0038 node-kind union',
    seed: (doc) => doc.getMap('nodes').set('g', { id: 'g', type: 'group', label: 'G', ...BOX }),
    found: /node "g".*type "group"/,
  },
]

describe('the body-node check is asked only of a document that can hold a body', () => {
  // The check keys on the id `okf-body`, which a canvas edit may mint for a
  // node in the current shape; a recorded spatial document is content all
  // the way down, so the probe must not refuse it while readSpatialCanvas
  // serves it.
  const bodyNode = {
    id: 'okf-body',
    ...BOX,
    resource: { mimeType: 'text/markdown', content: 'hi' },
  }
  it('does not refuse a recorded spatial document whose node is named okf-body', () => {
    const doc = docWith((d) => d.getMap('nodes').set('okf-body', bodyNode))
    writeDocumentKind(doc, 'spatial')
    expect(retiredStoredShapeIn(doc)).toBeNull()
    expect(readSpatialCanvas(doc).nodes.map((n) => n.id)).toContain('okf-body')
  })
  it.each(['markdown', undefined] as const)('refuses it on a document whose kind is %s', (kind) => {
    const doc = docWith((d) => d.getMap('nodes').set('okf-body', bodyNode))
    if (kind !== undefined) writeDocumentKind(doc, kind)
    expect(retiredStoredShapeIn(doc)).toMatch(/okf-body/)
  })
})

describe('a canvas element in a retired stored shape is refused, not dropped', () => {
  it.each(RETIRED)('refuses $name, naming what it found', ({ seed, found }) => {
    const doc = docWith(seed)
    expect(() => readSpatialCanvas(doc)).toThrow(RetiredStoredShapeError)
    expect(() => readSpatialCanvas(doc)).toThrow(found)
    expect(retiredStoredShapeIn(doc)).toMatch(found)
  })

  it('says the data was left as it was', () => {
    const doc = docWith(RETIRED[3]?.seed ?? (() => {}))
    expect(() => readSpatialCanvas(doc)).toThrow(/its data has not been changed/)
  })

  it('reads a canvas in the current shape as it always did', () => {
    const doc = docWith(() => {})
    expect(retiredStoredShapeIn(doc)).toBeNull()
    expect(readSpatialCanvas(doc).nodes.map((node) => node.id)).toEqual(['ok'])
  })
})
