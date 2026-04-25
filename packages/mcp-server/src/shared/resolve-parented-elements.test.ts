// Tests for the pure helper that resolves parent-referenced annotations to
// absolute coordinates right before rendering.
//
// Design:
//   - if an element has parentId + relX + relY, recompute from the parent's bbox
//   - if the parent is missing or deleted, fall back to the element's own x / y
//   - strip parentId/relX/relY from the output so Excalidraw can consume it
//   - do not mutate the original array or element objects

import { describe, expect, it } from 'vitest'
import { resolveParentedElements } from './resolve-parented-elements.js'

// Minimal test type. The implementation accepts the same shape.
type TestElement = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  parentId?: string
  relX?: number
  relY?: number
}

describe('resolveParentedElements', () => {
  it('returns elements without parentId unchanged', () => {
    const elements: TestElement[] = [
      { id: 'a', type: 'rectangle', x: 100, y: 200, width: 50, height: 50 },
    ]
    const out = resolveParentedElements(elements)
    expect(out[0]).toMatchObject({ id: 'a', x: 100, y: 200 })
  })

  it('removes parentId / relX / relY from output elements', () => {
    const elements: TestElement[] = [
      {
        id: 'parent',
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      {
        id: 'note',
        type: 'text',
        x: 10,
        y: 20,
        width: 0,
        height: 0,
        parentId: 'parent',
        relX: 0.5,
        relY: 0.5,
      },
    ]
    const out = resolveParentedElements(elements)
    const note = out.find((e) => e.id === 'note')!
    expect(note).not.toHaveProperty('parentId')
    expect(note).not.toHaveProperty('relX')
    expect(note).not.toHaveProperty('relY')
  })

  it('recomputes absolute coordinates from relX/relY when the parent is live', () => {
    const elements: TestElement[] = [
      { id: 'parent', type: 'image', x: 1000, y: 500, width: 200, height: 100 },
      {
        id: 'note',
        type: 'text',
        x: 0,
        y: 0, // stale values are overwritten when the parent is live
        width: 0,
        height: 0,
        parentId: 'parent',
        relX: 0.5,
        relY: 0.25,
      },
    ]
    const out = resolveParentedElements(elements)
    const note = out.find((e) => e.id === 'note')!
    // parent.x(1000) + relX(0.5) * width(200) = 1100
    // parent.y(500) + relY(0.25) * height(100) = 525
    expect(note.x).toBe(1100)
    expect(note.y).toBe(525)
  })

  it('falls back to the element x/y when the parent is missing', () => {
    const elements: TestElement[] = [
      {
        id: 'note',
        type: 'text',
        x: 42,
        y: 84,
        width: 0,
        height: 0,
        parentId: 'ghost',
        relX: 0.5,
        relY: 0.5,
      },
    ]
    const out = resolveParentedElements(elements)
    expect(out[0]).toMatchObject({ x: 42, y: 84 })
  })

  it('falls back when the parent isDeleted', () => {
    const elements: TestElement[] = [
      {
        id: 'parent',
        type: 'image',
        x: 999,
        y: 999,
        width: 100,
        height: 100,
        isDeleted: true,
      },
      {
        id: 'note',
        type: 'text',
        x: 7,
        y: 8,
        width: 0,
        height: 0,
        parentId: 'parent',
        relX: 0.5,
        relY: 0.5,
      },
    ]
    const out = resolveParentedElements(elements)
    const note = out.find((e) => e.id === 'note')!
    expect(note.x).toBe(7)
    expect(note.y).toBe(8)
  })

  it('does not mutate the input array or input elements', () => {
    const original = {
      id: 'note',
      type: 'text' as const,
      x: 10,
      y: 20,
      width: 0,
      height: 0,
      parentId: 'parent',
      relX: 0.5,
      relY: 0.5,
    }
    const elements: TestElement[] = [
      { id: 'parent', type: 'image', x: 100, y: 200, width: 200, height: 100 },
      original,
    ]
    const snapshot = JSON.parse(JSON.stringify(elements))
    resolveParentedElements(elements)
    expect(elements).toEqual(snapshot)
    // The original object reference remains unchanged.
    expect(original.parentId).toBe('parent')
    expect(original.x).toBe(10)
  })

  it('uses the resolved parent position when the parent also has a parent reference', () => {
    // grand -> parent -> child chain. The parent resolves against grand first,
    // then the child resolves against the parent's resolved position.
    const elements: TestElement[] = [
      { id: 'grand', type: 'image', x: 1000, y: 1000, width: 400, height: 200 },
      {
        id: 'parent',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        parentId: 'grand',
        relX: 0.5, // grand(1000,1000) + 0.5*400 = 1200
        relY: 0.5, // grand(1000,1000) + 0.5*200 = 1100
      },
      {
        id: 'child',
        type: 'text',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        parentId: 'parent',
        relX: 0.5, // parent.resolvedX(1200) + 0.5 * parent.width(200) = 1300
        relY: 0.5, // parent.resolvedY(1100) + 0.5 * parent.height(100) = 1150
      },
    ]
    const out = resolveParentedElements(elements)
    const parent = out.find((e) => e.id === 'parent')!
    const child = out.find((e) => e.id === 'child')!
    expect(parent.x).toBe(1200)
    expect(parent.y).toBe(1100)
    expect(child.x).toBe(1300)
    expect(child.y).toBe(1150)
  })
})
