import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { appendAnnotationToDoc } from './annotate.js'
import { contrastRatio } from './color-palette.js'

function appendBox(doc: LoroDoc, over: Record<string, unknown> = {}) {
  return appendAnnotationToDoc(doc, {
    type: 'box_with_label',
    coords: 'absolute',
    target: { x: 0, y: 0 },
    width: 240,
    height: 140,
    title: 'Title',
    text: 'Body',
    subText: 'Sub',
    ...over,
  } as never)
}

function textStrokeColors(doc: LoroDoc): string[] {
  return (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>)
    .filter((e) => e.type === 'text')
    .map((e) => e.strokeColor as string)
}

function rectStrokeColor(doc: LoroDoc): string {
  return (doc.getMovableList('elements').toJSON() as Array<Record<string, unknown>>).find(
    (e) => e.type === 'rectangle',
  )?.strokeColor as string
}

describe('box_with_label readable-ink guard on solid fills', () => {
  it('replaces a low-contrast semantic ink with a readable one for title, body, and subText', () => {
    const doc = new LoroDoc()
    // neutral (#6c757d) on success (#2f9e44) is ~1.2:1 — illegible.
    appendBox(doc, { color: 'neutral', backgroundColor: 'success', fillStyle: 'solid' })

    const inks = textStrokeColors(doc)
    expect(inks).toHaveLength(3)
    for (const ink of inks) {
      expect(contrastRatio(ink, '#2f9e44')).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps the requested color on the rectangle stroke (guard applies to text ink only)', () => {
    const doc = new LoroDoc()
    appendBox(doc, { color: 'neutral', backgroundColor: 'success', fillStyle: 'solid' })

    expect(rectStrokeColor(doc)).toBe('#6c757d')
  })

  it('honors an explicit hex ink even when its contrast against the fill is poor', () => {
    const doc = new LoroDoc()
    appendBox(doc, { color: '#6c757d', backgroundColor: 'success', fillStyle: 'solid' })

    for (const ink of textStrokeColors(doc)) {
      expect(ink).toBe('#6c757d')
    }
  })

  it('leaves a semantic ink alone when its contrast against the fill is already sufficient', () => {
    const doc = new LoroDoc()
    // danger (#e03131) on a very light fill reads fine; contrast >= 3.
    appendBox(doc, { color: 'danger', backgroundColor: '#f8f9fa', fillStyle: 'solid' })

    for (const ink of textStrokeColors(doc)) {
      expect(ink).toBe('#e03131')
    }
  })

  it('does not adjust ink when the box has no backgroundColor', () => {
    const doc = new LoroDoc()
    appendBox(doc, { color: 'neutral' })

    for (const ink of textStrokeColors(doc)) {
      expect(ink).toBe('#6c757d')
    }
  })

  it('guards the default ink too when the fill is dark and color is omitted', () => {
    const doc = new LoroDoc()
    // Default text ink #1e1e2e on a near-black fill would vanish.
    appendBox(doc, { backgroundColor: '#212529', fillStyle: 'solid' })

    for (const ink of textStrokeColors(doc)) {
      expect(contrastRatio(ink, '#212529')).toBeGreaterThanOrEqual(3)
    }
  })
})
