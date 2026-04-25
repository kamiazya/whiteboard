import { describe, it, expect } from 'vitest'
import { resolveLibraryItem } from './resolve-library-item.js'
function idGenFactory() {
  let i = 0
  return () => `new-${i++}`
}

describe('resolveLibraryItem', () => {
  it('case 108', () => {
    const out = resolveLibraryItem(
      [
        {
          id: 'orig-1',
          type: 'rectangle',
          x: 100,
          y: 200,
          width: 80,
          height: 60,
        },
      ],
      { x: 0, y: 0 },
      idGenFactory(),
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('new-0')
    expect(out[0].x).toBe(0)
    expect(out[0].y).toBe(0)
    expect(out[0].width).toBe(80)
    expect(out[0].height).toBe(60)
  })

  it('case 109', () => {
    const out = resolveLibraryItem(
      [
        { id: 'a', type: 'rectangle', x: 100, y: 100, width: 50, height: 50 },
        { id: 'b', type: 'rectangle', x: 200, y: 300, width: 50, height: 50 },
      ],
      { x: 10, y: 20 },
      idGenFactory(),
    )
    expect(out[0]).toMatchObject({ x: 10, y: 20 })
    expect(out[1]).toMatchObject({ x: 110, y: 220 })
  })

  it('case 110', () => {
    const out = resolveLibraryItem(
      [
        { id: 'a', type: 'rectangle', x: 100, y: 100, width: 40, height: 20 },
        { id: 'b', type: 'rectangle', x: 130, y: 140, width: 10, height: 10 },
      ],
      { x: 10, y: 20 },
      idGenFactory(),
      2,
    )
    expect(out[0]).toMatchObject({ x: 10, y: 20, width: 80, height: 40 })
    expect(out[1]).toMatchObject({ x: 70, y: 100, width: 20, height: 20 })
  })

  it('case 111', () => {
    const out = resolveLibraryItem(
      [
        { id: 'box', type: 'rectangle', x: 100, y: 100, width: 50, height: 50 },
        {
          id: 'arrow',
          type: 'arrow',
          x: 150,
          y: 120,
          width: 80,
          height: 10,
          points: [
            [0, 0],
            [80, 10],
          ],
          fontSize: 20,
          strokeWidth: 2,
          startBinding: { elementId: 'box', gap: 4, focus: 0.1 },
        },
      ],
      { x: 0, y: 0 },
      idGenFactory(),
      0.5,
    )
    const arrow = out.find((e) => e.type === 'arrow')!
    expect(arrow).toMatchObject({
      x: 25,
      y: 10,
      width: 40,
      height: 5,
      fontSize: 10,
      strokeWidth: 1,
    })
    expect(arrow.points).toEqual([
      [0, 0],
      [40, 5],
    ])
    expect(arrow.startBinding).toMatchObject({ gap: 2, focus: 0.1 })
  })

  it('rejects non-positive or non-finite scale values', () => {
    const input = [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }]
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLibraryItem(input, { x: 0, y: 0 }, idGenFactory(), bad)).toThrow(
        /scale must be a positive number/,
      )
    }
  })

  it('case 112', () => {
    const out = resolveLibraryItem(
      [
        { id: 'rect-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
        {
          id: 'text-1',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          containerId: 'rect-1',
        },
      ],
      { x: 0, y: 0 },
      idGenFactory(),
    )
    const rect = out.find((e) => e.type === 'rectangle')!
    const text = out.find((e) => e.type === 'text')!
    expect(text.containerId).toBe(rect.id)
    expect(rect.id).toBe('new-0')
    expect(text.id).toBe('new-1')
  })

  it('case 113', () => {
    const out = resolveLibraryItem(
      [
        {
          id: 'rect-1',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          boundElements: [
            { id: 'text-1', type: 'text' },
            { id: 'outside', type: 'arrow' }, // External id should be dropped
          ],
        },
        { id: 'text-1', type: 'text', x: 0, y: 0, width: 100, height: 60 },
      ],
      { x: 0, y: 0 },
      idGenFactory(),
    )
    const rect = out.find((e) => e.type === 'rectangle')!
    const text = out.find((e) => e.type === 'text')!
    const bound = rect.boundElements as { id: string; type: string }[]
    expect(bound).toHaveLength(1)
    expect(bound[0].id).toBe(text.id)
  })

  it('case 114', () => {
    const out = resolveLibraryItem(
      [
        { id: 'a', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
        { id: 'b', type: 'rectangle', x: 100, y: 0, width: 50, height: 50 },
        {
          id: 'arrow-1',
          type: 'arrow',
          x: 50,
          y: 25,
          width: 50,
          height: 0,
          startBinding: { elementId: 'a', focus: 0, gap: 0 },
          endBinding: { elementId: 'b', focus: 0, gap: 0 },
        },
      ],
      { x: 0, y: 0 },
      idGenFactory(),
    )
    const a = out.find((e) => e.id === 'new-0')!
    const b = out.find((e) => e.id === 'new-1')!
    const arrow = out.find((e) => e.type === 'arrow')!
    expect((arrow.startBinding as { elementId: string }).elementId).toBe(a.id)
    expect((arrow.endBinding as { elementId: string }).elementId).toBe(b.id)
  })

  it('case 115', () => {
    const input = [{ id: 'a', type: 'rectangle', x: 100, y: 200, width: 50, height: 50 }]
    const snapshot = JSON.stringify(input)
    resolveLibraryItem(input, { x: 0, y: 0 }, idGenFactory())
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
