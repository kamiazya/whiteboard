import { describe, it, expect } from 'vitest'
import { decomposeGroup } from './group.js'
//

interface Elem {
  id: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
}

const E = (id: string, x: number, y: number, w: number, h: number): Elem => ({
  id,
  x,
  y,
  width: w,
  height: h,
})

describe('decomposeGroup', () => {
  it('case 127', () => {
    const elements = [E('a', 100, 200, 50, 40)]
    const [rect] = decomposeGroup({ elements, memberIds: ['a'], padding: 10 })
    expect(rect).toMatchObject({
      type: 'rectangle',
      target: { x: 90, y: 190 },
      width: 70,
      height: 60,
    })
  })

  it('case 128', () => {
    const elements = [
      E('a', 100, 100, 50, 50), // right=150, bottom=150
      E('b', 200, 300, 40, 20), // right=240, bottom=320
      E('c', 50, 200, 30, 30), // right=80, bottom=230
    ]
    const [rect] = decomposeGroup({
      elements,
      memberIds: ['a', 'b', 'c'],
      padding: 0,
    })
    // min x=50, min y=100, max right=240, max bottom=320
    expect(rect).toMatchObject({
      target: { x: 50, y: 100 },
      width: 190,
      height: 220,
    })
  })

  it('case 129', () => {
    const elements = [E('a', 100, 100, 50, 50)]
    const [rect] = decomposeGroup({ elements, memberIds: ['a'] })
    expect(rect).toMatchObject({
      target: { x: 80, y: 80 },
      width: 90,
      height: 90,
    })
  })

  it('case 130', () => {
    const elements = [E('a', 0, 0, 10, 10)]
    const [rect] = decomposeGroup({
      elements,
      memberIds: ['a'],
      padding: 0,
      color: '#1971c2',
    })
    expect(rect!.color).toBe('#1971c2')
  })
  it('case 131', () => {
    const elements = [E('a', 0, 0, 10, 10)]
    const [, , diag] = decomposeGroup({
      elements,
      memberIds: ['a', 'ghost', 'also-missing'],
      padding: 0,
    })
    expect(diag.missingMemberIds).toEqual(['ghost', 'also-missing'])
  })

  it('case 132', () => {
    const elements = [E('a', 100, 100, 50, 50)]
    const [rect] = decomposeGroup({
      elements,
      memberIds: ['a', 'ghost'],
      padding: 0,
    })
    expect(rect).toMatchObject({
      target: { x: 100, y: 100 },
      width: 50,
      height: 50,
    })
  })

  it('case 133', () => {
    const elements: Elem[] = [
      { id: 'a', x: 100, y: 100, width: 50, height: 50 },
      { id: 'b', x: 1000, y: 1000, width: 50, height: 50, isDeleted: true },
    ]
    const [rect, , diag] = decomposeGroup({
      elements,
      memberIds: ['a', 'b'],
      padding: 0,
    })
    expect(rect).toMatchObject({ target: { x: 100, y: 100 }, width: 50, height: 50 })
    expect(diag.missingMemberIds).toContain('b')
  })

  it('case 134', () => {
    const [rect, title, diag] = decomposeGroup({
      elements: [],
      memberIds: ['ghost-1', 'ghost-2'],
      padding: 0,
    })
    expect(rect).toBeUndefined()
    expect(title).toBeUndefined()
    expect(diag.missingMemberIds).toEqual(['ghost-1', 'ghost-2'])
  })
  it('case 135', () => {
    const elements = [E('a', 100, 100, 50, 50)]
    const result = decomposeGroup({ elements, memberIds: ['a'], padding: 0 })
    expect(result[1]).toBeUndefined()
  })

  it('case 136', () => {
    const elements = [E('a', 100, 100, 50, 50)]
    const [, title] = decomposeGroup({
      elements,
      memberIds: ['a'],
      padding: 0,
      title: 'Group A',
    })
    expect(title).toBeDefined()
    expect(title!.type).toBe('text')
    expect(title!.text).toBe('Group A')
  })

  it('case 137', () => {
    const elements = [E('a', 100, 200, 50, 50)]
    const [rect, title] = decomposeGroup({
      elements,
      memberIds: ['a'],
      padding: 10,
      title: 'Group A',
    })
    expect(title!.target.y).toBeLessThan(rect!.target.y)
  })

  it('case 138', () => {
    const elements = [E('a', 100, 200, 50, 50)]
    const [rect, title] = decomposeGroup({
      elements,
      memberIds: ['a'],
      padding: 10,
      title: 'Group A',
    })
    expect(title!.target.x).toBe(rect!.target.x)
    expect(title!.width).toBe(rect!.width)
  })

  it('case 139', () => {
    const elements = [E('a', 0, 0, 10, 10)]
    const [, title] = decomposeGroup({
      elements,
      memberIds: ['a'],
      padding: 0,
      title: ['line 1', 'line 2'],
    })
    expect(title!.text).toBe('line 1\nline 2')
  })

  it('case 140', () => {
    const elements = [E('a', 0, 0, 10, 10)]
    const [rect, title] = decomposeGroup({
      elements,
      memberIds: ['a'],
      padding: 0,
      title: 'T',
      color: '#1971c2',
    })
    expect(rect!.color).toBe('#1971c2')
    expect(title!.color).toBe('#1971c2')
  })
})
