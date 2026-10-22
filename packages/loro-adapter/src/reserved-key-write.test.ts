/**
 * A value holding an own `__proto__` key — what `JSON.parse` and the YAML
 * parser hand a writer — is stored by `map.set` and comes back from every
 * projection with its prototype replaced: the shape the sync judge refuses
 * as `reserved_map_key`. Every value writer here refuses it the same way,
 * before writing anything.
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeCoreFacets, writeFacets, writeTrustFacets } from './document-envelope.js'
import {
  reconcileCoreFacets,
  reconcileFacets,
  writeCanvasFacetsField,
} from './document-envelope-reconcile.js'
import {
  reconcileSpatialCanvas,
  withSpatialBatch,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from './loro-bridge.js'
import { ReservedKeyWriteError } from './reserved-key-write.js'

/** A facets bucket whose payload holds the key as an own property. */
const facets = () => JSON.parse('{"acme.x/v0":{"__proto__":{"k":1}}}')

const NODE: SpatialNode = textNode({ id: 'n1', x: 0, y: 0, width: 10, height: 10, text: 'a' })
const withFacets = <T extends object>(value: T) => ({ ...value, facets: facets() })

const WRITES: ReadonlyArray<readonly [string, (doc: LoroDoc) => void]> = [
  ['writeFacets', (doc) => writeFacets(doc, facets())],
  [
    'writeCoreFacets, a nested key',
    (doc) => writeCoreFacets(doc, { type: 'note', facetsRaw: JSON.parse('{"x":{"__proto__":1}}') }),
  ],
  [
    'writeCoreFacets, a root key',
    (doc) => writeCoreFacets(doc, { type: 'note', ...JSON.parse('{"__proto__":{"a":1}}') }),
  ],
  [
    'writeTrustFacets',
    (doc) => writeTrustFacets(doc, JSON.parse('{"generated":{"__proto__":{"a":1}}}')),
  ],
  ['reconcileFacets', (doc) => reconcileFacets(doc, {}, facets())],
  [
    'reconcileCoreFacets',
    (doc) =>
      reconcileCoreFacets(doc, undefined, {
        type: 'note',
        facetsRaw: JSON.parse('{"x":{"__proto__":1}}'),
      }),
  ],
  ['writeCanvasFacetsField', (doc) => writeCanvasFacetsField(doc, facets())],
  ['writeSpatialNode', (doc) => writeSpatialNode(doc, withFacets(NODE))],
  [
    'writeSpatialEdge',
    (doc) => writeSpatialEdge(doc, withFacets({ id: 'e1', fromNode: 'n1', toNode: 'n1' } as never)),
  ],
  [
    'writeSpatialCanvas',
    (doc) =>
      writeSpatialCanvas(doc, { nodes: [NODE, withFacets({ ...NODE, id: 'n2' })], edges: [] }),
  ],
  [
    'writeSpatialCanvas, the canvas facets',
    (doc) => writeSpatialCanvas(doc, { nodes: [NODE], edges: [], facets: facets() }),
  ],
  [
    'reconcileSpatialCanvas',
    (doc) =>
      reconcileSpatialCanvas(
        doc,
        { nodes: [], edges: [] },
        { nodes: [NODE, withFacets({ ...NODE, id: 'n2' })], edges: [] },
      ),
  ],
  [
    'a batch writeNode',
    (doc) => withSpatialBatch(doc, (writer) => writer.writeNode(withFacets(NODE))),
  ],
  [
    'a batch writeLine',
    (doc) =>
      withSpatialBatch(doc, (writer) =>
        writer.writeLine(
          withFacets({ id: 'l1', from: { point: [0, 0] }, to: { point: [1, 1] } } as never),
        ),
      ),
  ],
]

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  const canvas: SpatialCanvas = { nodes: [{ ...NODE, id: 'n0' }], edges: [] }
  writeSpatialCanvas(doc, canvas)
  writeFacets(doc, { 'acme.y/v0': { kept: true } })
  writeCoreFacets(doc, { type: 'note' })
  return doc
}

describe('a value writer refuses a key named __proto__', () => {
  it.each(WRITES)('%s', (_label, write) => {
    const doc = seeded()
    const before = JSON.stringify(doc.toJSON())
    const version = doc.oplogVersion().toJSON()

    let thrown: unknown
    try {
      write(doc)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ReservedKeyWriteError)
    expect(thrown).toMatchObject({ code: 'reserved_map_key' })
    expect((thrown as Error).message).toContain('"__proto__"')
    // Refused before the first op: nothing pending, nothing committed.
    expect(JSON.stringify(doc.toJSON())).toBe(before)
    doc.commit()
    expect(doc.oplogVersion().toJSON()).toEqual(version)
  })

  it('still writes a value that only names the key as a string', () => {
    const doc = seeded()
    writeFacets(doc, { 'acme.x/v0': { key: '__proto__' } })
    expect(doc.getMap('facets').get('acme.x/v0')).toEqual({ key: '__proto__' })
  })
})
