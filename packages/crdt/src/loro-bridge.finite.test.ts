// A non-finite coordinate written into the Loro doc silently DELETES the
// node for every reader: readSpatialCanvas round-trips through
// spatialNodeSchema.safeParse and drops failures without a signal, so a
// caller bug (NaN from arithmetic on positions) becomes undo-proof data
// loss across every synced peer. The write path therefore refuses
// non-finite geometry loudly — a thrown TypeError at the buggy call site
// beats a node quietly vanishing everywhere else.
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { readSpatialCanvas, writeSpatialCanvas, writeSpatialNode } from './loro-bridge.js'

const node = (overrides: Partial<Extract<SpatialNode, { type: 'text' }>>): SpatialNode => ({
  id: 'n1',
  type: 'text',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  text: 'x',
  ...overrides,
})

describe('finite-geometry write guard', () => {
  for (const [field, value] of [
    ['x', Number.NaN],
    ['y', Number.POSITIVE_INFINITY],
    ['width', Number.NEGATIVE_INFINITY],
    ['height', Number.NaN],
  ] as const) {
    it(`refuses a non-finite ${field} instead of poisoning the doc`, () => {
      const doc = new LoroDoc()
      expect(() => writeSpatialNode(doc, node({ [field]: value }))).toThrow(/finite/)
    })
  }

  it('a canvas write with one poisoned node throws and writes nothing partial for it', () => {
    const doc = new LoroDoc()
    expect(() =>
      writeSpatialCanvas(doc, {
        nodes: [node({}), node({ id: 'bad', x: Number.NaN })],
        edges: [],
      }),
    ).toThrow(/finite/)
  })

  it('finite geometry still round-trips unchanged', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [node({ x: -40, y: 12 })], edges: [] })
    expect(readSpatialCanvas(doc).nodes[0]).toMatchObject({ x: -40, y: 12 })
  })
})
