import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import type { PeerID } from 'loro-crdt'
import { VersionVector } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { makeSpatialDoc } from '../test-utils/spatial-doc.js'
import { detectMergeBadges, type MergeBadge, meetVersion } from './merge-engine.js'

// Small fixed peer-id pool so generated vectors actually overlap on some
// peers and diverge on others — the case meetVersion exists for.
const peerIds = ['1', '2', '3'] as const satisfies readonly PeerID[]

// A peer count of 1..N, never 0: a real LoroDoc version vector from
// `.version()` never records an explicit zero-count peer (a peer with no ops
// is simply absent), so a 0 count here would test the arbitrary, not
// meetVersion.
const versionVectorArbitrary = fc
  .dictionary(fc.constantFrom(...peerIds), fc.integer({ min: 1, max: 20 }))
  .map((counts) => new VersionVector(new Map(Object.entries(counts) as [PeerID, number][])))

describe('detectMergeBadges', () => {
  it('returns no badges when base / target / source / preview all match', () => {
    const canvas = {
      nodes: [{ id: 'a', type: 'text' as const, text: 'hi', x: 0, y: 0, width: 100, height: 100 }],
      edges: [],
    }
    const base = makeSpatialDoc(canvas)
    const target = makeSpatialDoc(canvas)
    const source = makeSpatialDoc(canvas)
    const preview = makeSpatialDoc(canvas)
    expect(detectMergeBadges({ base, target, source, preview })).toEqual([])
  })

  it('detects resurrection when base has a node the target deleted but source (preview) kept', () => {
    const base = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'B', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    // Target rewrote the canvas without A.
    const target = makeSpatialDoc({
      nodes: [{ id: 'B', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    // Source kept both A and B unchanged.
    const source = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'B', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    // Tip-adoption: preview is the source tip.
    const preview = source
    const badges = detectMergeBadges({ base, target, source, preview })
    expect(badges).toEqual<MergeBadge[]>([{ type: 'resurrected', elementId: 'A' }])
  })

  it('detects an orphan ref when an edge in preview has no matching node (corrupt-doc defensive net)', () => {
    const base = makeSpatialDoc({ nodes: [], edges: [] })
    const target = makeSpatialDoc({ nodes: [], edges: [] })
    const source = makeSpatialDoc({
      nodes: [
        { id: 'n1', type: 'text', text: '1', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: '2', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    // Directly corrupt the nodes map, bypassing deleteSpatialNode's edge
    // cascade — the bridge's normal write paths can never produce this
    // shape, but a foreign or hand-edited doc could.
    source.getMap('nodes').delete('n2')
    const preview = source
    const badges = detectMergeBadges({ base, target, source, preview })
    expect(badges).toEqual<MergeBadge[]>([
      { type: 'orphan_ref', elementId: 'e1', missingRef: 'n2' },
    ])
  })

  it('detects field-level conflict when both branches change the same field to different values', () => {
    const base = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'base', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    const target = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'target-edit', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    const source = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'source-edit', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    const preview = source
    const badges = detectMergeBadges({ base, target, source, preview })
    expect(badges).toEqual<MergeBadge[]>([
      { type: 'field_merge', elementId: 'A', fields: ['text'] },
    ])
  })

  it('does not flag a field only one side changed', () => {
    const base = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'base', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    // Target-only edit: source stays at base.
    const targetOnly = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'target-edit', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    const unchanged = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'base', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    expect(
      detectMergeBadges({
        base,
        target: targetOnly,
        source: unchanged,
        preview: unchanged,
      }),
    ).toEqual([])

    // Source-only edit: target stays at base.
    const sourceOnly = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'source-edit', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    expect(
      detectMergeBadges({
        base,
        target: unchanged,
        source: sourceOnly,
        preview: sourceOnly,
      }),
    ).toEqual([])
  })

  it('skips a same-id double-create absent from base', () => {
    const base = makeSpatialDoc({ nodes: [], edges: [] })
    const target = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'from-target', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    const source = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'from-source', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    const preview = source
    expect(detectMergeBadges({ base, target, source, preview })).toEqual([])
  })

  it('ignores an id that exists in neither target nor source', () => {
    const canvas = {
      nodes: [{ id: 'a', type: 'text' as const, text: 'hi', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    }
    const base = makeSpatialDoc(canvas)
    const target = makeSpatialDoc(canvas)
    const source = makeSpatialDoc(canvas)
    const preview = makeSpatialDoc({
      nodes: [
        ...canvas.nodes,
        { id: 'ghost', type: 'text' as const, text: 'nope', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    expect(detectMergeBadges({ base, target, source, preview })).toEqual([])
  })

  it('detects multiple badges at once in stable order', () => {
    const base = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'C', type: 'text', text: 'base', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n1', type: 'text', text: '1', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: '2', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    // Target deleted A and edited C, leaving n1/n2/e1 untouched.
    const target = makeSpatialDoc({
      nodes: [
        { id: 'C', type: 'text', text: 'target-edit', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n1', type: 'text', text: '1', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: '2', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    // Source kept A, edited C, and kept n1/n2/e1 unchanged.
    const source = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'C', type: 'text', text: 'source-edit', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n1', type: 'text', text: '1', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: '2', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    // Corrupt the preview directly, bypassing deleteSpatialNode's edge
    // cascade, so e1 becomes an orphan alongside the resurrected/field_merge
    // cases already present from A and C.
    source.getMap('nodes').delete('n2')
    const preview = source
    const badges = detectMergeBadges({ base, target, source, preview })
    expect(badges).toEqual<MergeBadge[]>([
      { type: 'resurrected', elementId: 'A' },
      { type: 'orphan_ref', elementId: 'e1', missingRef: 'n2' },
      { type: 'field_merge', elementId: 'C', fields: ['text'] },
    ])
  })

  // No-op merge identity: merging a doc against itself on every side must
  // never fire a badge, for any valid spatial canvas shape.
  fcTest.prop([spatialCanvasArbitrary], withDefaults())(
    'is empty when base / target / source / preview all hold the same canvas',
    (canvas) => {
      const base = makeSpatialDoc(canvas)
      const target = makeSpatialDoc(canvas)
      const source = makeSpatialDoc(canvas)
      const preview = makeSpatialDoc(canvas)
      expect(detectMergeBadges({ base, target, source, preview })).toEqual([])
    },
  )
})

describe('meetVersion', () => {
  it('takes the per-peer minimum, omitting a peer present on only one side', () => {
    const a = new VersionVector(
      new Map<PeerID, number>([
        ['1', 3],
        ['2', 5],
      ]),
    )
    const b = new VersionVector(
      new Map<PeerID, number>([
        ['2', 2],
        ['3', 7],
      ]),
    )
    expect(meetVersion(a, b).toJSON()).toEqual(new Map<PeerID, number>([['2', 2]]))
  })

  fcTest.prop([versionVectorArbitrary], withDefaults())('is idempotent: meet(a, a) === a', (a) => {
    expect(meetVersion(a, a).toJSON()).toEqual(a.toJSON())
  })

  fcTest.prop([versionVectorArbitrary, versionVectorArbitrary], withDefaults())(
    'is commutative: meet(a, b) === meet(b, a)',
    (a, b) => {
      expect(meetVersion(a, b).toJSON()).toEqual(meetVersion(b, a).toJSON())
    },
  )

  fcTest.prop([versionVectorArbitrary, versionVectorArbitrary], withDefaults())(
    'is a lower bound: every peer count in the meet is <= both inputs',
    (a, b) => {
      const meet = meetVersion(a, b).toJSON()
      const aCounts = a.toJSON()
      const bCounts = b.toJSON()
      for (const [peer, count] of meet) {
        expect(count).toBeLessThanOrEqual(aCounts.get(peer) ?? 0)
        expect(count).toBeLessThanOrEqual(bCounts.get(peer) ?? 0)
      }
    },
  )
})
