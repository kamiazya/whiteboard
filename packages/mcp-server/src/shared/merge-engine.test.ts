import { describe, it, expect } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { detectMergeBadges, type MergeBadge } from './merge-engine.js'

// Helper that builds ad-hoc LoroDocs for target / source / preview. These tests
// directly provide plain element state objects and only verify badge detection.
type El = Record<string, unknown>

function docOf(elements: El[]): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  for (const el of elements) {
    const m = list.insertContainer(list.length, new LoroMap())
    for (const [k, v] of Object.entries(el)) {
      m.set(k, v as Parameters<LoroMap['set']>[1])
    }
  }
  doc.commit()
  return doc
}

describe('detectMergeBadges', () => {
  it('returns no badges when target / source / preview match exactly', () => {
    const target = docOf([{ id: 'a', type: 'rectangle', isDeleted: false }])
    const source = docOf([{ id: 'a', type: 'rectangle', isDeleted: false }])
    const preview = docOf([{ id: 'a', type: 'rectangle', isDeleted: false }])
    const badges = detectMergeBadges({ target, source, preview })
    expect(badges).toEqual([])
  })

  it('detects resurrection when target is deleted but preview is live', () => {
    const target = docOf([{ id: 'a', type: 'rectangle', isDeleted: true }])
    const source = docOf([{ id: 'a', type: 'rectangle', isDeleted: false, fill: 'blue' }])
    const preview = docOf([{ id: 'a', type: 'rectangle', isDeleted: false, fill: 'blue' }])
    const badges = detectMergeBadges({ target, source, preview })
    expect(badges).toEqual<MergeBadge[]>([
      { type: 'resurrected', elementId: 'a' },
    ])
  })

  it('detects orphan refs when a source arrow points to a target-deleted parent', () => {
    const target = docOf([
      // X is deleted in target.
      { id: 'X', type: 'rectangle', isDeleted: true },
    ])
    const source = docOf([
      { id: 'X', type: 'rectangle', isDeleted: false },
      {
        id: 'a',
        type: 'arrow',
        isDeleted: false,
        startBinding: { elementId: 'X', focus: 0, gap: 0 },
      },
    ])
    const preview = docOf([
      // LWW result: X stays tombstoned and a comes from source.
      { id: 'X', type: 'rectangle', isDeleted: true },
      {
        id: 'a',
        type: 'arrow',
        isDeleted: false,
        startBinding: { elementId: 'X', focus: 0, gap: 0 },
      },
    ])
    const badges = detectMergeBadges({ target, source, preview })
    // X stays tombstoned, so there is no resurrection badge.
    // a references X, so it should produce an orphan_ref badge.
    expect(badges).toEqual<MergeBadge[]>([{ type: 'orphan_ref', elementId: 'a', missingRef: 'X' }])
  })

  it('detects field-level merge when preview mixes winners across fields', () => {
    const target = docOf([{ id: 'B', type: 'rectangle', strokeColor: '#9333ea', backgroundColor: '#e7f5ff' }])
    const source = docOf([{ id: 'B', type: 'rectangle', strokeColor: '#1971c2', backgroundColor: '#dcfce7' }])
    // preview mixes winners: strokeColor from target, backgroundColor from source.
    const preview = docOf([
      { id: 'B', type: 'rectangle', strokeColor: '#9333ea', backgroundColor: '#dcfce7' },
    ])
    const badges = detectMergeBadges({ target, source, preview })
    expect(badges).toEqual<MergeBadge[]>([
      { type: 'field_merge', elementId: 'B', fields: ['backgroundColor'] },
    ])
  })

  it('detects multiple badges at once in stable order', () => {
    const target = docOf([
      { id: 'a', type: 'rectangle', isDeleted: true },
      { id: 'X', type: 'rectangle', isDeleted: true },
      { id: 'B', type: 'rectangle', strokeColor: '#000' },
    ])
    const source = docOf([
      { id: 'a', type: 'rectangle', isDeleted: false },
      { id: 'X', type: 'rectangle', isDeleted: false },
      { id: 'B', type: 'rectangle', strokeColor: '#fff' },
      {
        id: 'arr',
        type: 'arrow',
        isDeleted: false,
        endBinding: { elementId: 'X', focus: 0, gap: 0 },
      },
    ])
    const preview = docOf([
      { id: 'a', type: 'rectangle', isDeleted: false }, // resurrected
      { id: 'X', type: 'rectangle', isDeleted: true }, // still tombstoned
      { id: 'B', type: 'rectangle', strokeColor: '#fff' }, // source wins strokeColor -> field_merge
      {
        id: 'arr',
        type: 'arrow',
        isDeleted: false,
        endBinding: { elementId: 'X', focus: 0, gap: 0 },
      }, // orphan (X is tombstoned)
    ])
    const badges = detectMergeBadges({ target, source, preview })
    expect(badges).toContainEqual<MergeBadge>({ type: 'resurrected', elementId: 'a' })
    expect(badges).toContainEqual<MergeBadge>({ type: 'orphan_ref', elementId: 'arr', missingRef: 'X' })
    expect(badges).toContainEqual<MergeBadge>({
      type: 'field_merge',
      elementId: 'B',
      fields: ['strokeColor'],
    })
  })

  it('ignores elements that exist in neither target nor source', () => {
    const target = docOf([{ id: 'a', type: 'rectangle' }])
    const source = docOf([{ id: 'a', type: 'rectangle' }])
    const preview = docOf([
      { id: 'a', type: 'rectangle' },
      { id: 'ghost', type: 'rectangle' }, // should not exist
    ])
    const badges = detectMergeBadges({ target, source, preview })
    expect(badges).toEqual([])
  })
})
