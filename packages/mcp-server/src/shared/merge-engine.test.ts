import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect, it } from 'vitest'
import { detectMergeBadges, type MergeBadge } from './merge-engine.js'
import { fcTest, withDefaults } from './test-utils/fast-check.js'
import { makeSpatialDoc } from './test-utils/spatial-doc.js'

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
