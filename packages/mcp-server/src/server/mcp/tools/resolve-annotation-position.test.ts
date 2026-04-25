import { describe, it, expect } from 'vitest'
import { resolveAnnotationPosition } from './resolve-annotation-position.js'

const IMG_A = {
  id: 'img-a',
  type: 'image',
  x: 100,
  y: 200,
  width: 400,
  height: 300,
  isDeleted: false,
}
const IMG_B = {
  id: 'img-b',
  type: 'image',
  x: 1000,
  y: 1000,
  width: 200,
  height: 100,
  isDeleted: false,
}
const IMG_DELETED = { ...IMG_A, id: 'img-dead', isDeleted: true }

describe('resolveAnnotationPosition - coords: "absolute"', () => {
  it('case 148', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'absolute', target: { x: 50, y: 75 } },
      [IMG_A],
    )
    expect(pos).toEqual({ x: 50, y: 75 })
  })

  it('case 149', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'absolute', target: { x: 10, y: 20 } },
      [],
    )
    expect(pos).toEqual({ x: 10, y: 20 })
  })

  it('case 150', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'absolute', imageId: 'img-a', target: { x: 5, y: 5 } },
      [IMG_A, IMG_B],
    )
    expect(pos).toEqual({ x: 5, y: 5 })
  })
})

describe('resolveAnnotationPosition - coords: "relative"', () => {
  it('case 151', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'relative', imageId: 'img-b', target: { x: 0.5, y: 1 } },
      [IMG_A, IMG_B],
    )
    // IMG_B: (1000, 1000) + (0.5*200, 1*100) = (1100, 1100)
    expect(pos).toEqual({ x: 1100, y: 1100 })
  })

  it('case 152', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'relative', target: { x: 0, y: 0 } },
      [IMG_DELETED, IMG_A, IMG_B],
    )
    expect(pos).toEqual({ x: 100, y: 200 })
  })

  it('case 153', () => {
    expect(() =>
      resolveAnnotationPosition({ coords: 'relative', target: { x: 0.5, y: 0.5 } }, []),
    ).toThrow(/relative.*image/i)
  })

  it('case 154', () => {
    expect(() =>
      resolveAnnotationPosition(
        { coords: 'relative', imageId: 'missing', target: { x: 0.5, y: 0.5 } },
        [IMG_A],
      ),
    ).toThrow(/imageId.*missing/i)
  })
})

describe('resolveAnnotationPosition - coords: "parent"', () => {
  it('case 155', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'parent', imageId: 'img-b', target: { x: 0.5, y: 1 } },
      [IMG_A, IMG_B],
    )
    // IMG_B: (1000, 1000) + (0.5*200, 1*100) = (1100, 1100)
    expect(pos).toEqual({
      x: 1100,
      y: 1100,
      parentId: 'img-b',
      relX: 0.5,
      relY: 1,
    })
  })

  it('case 156', () => {
    const pos = resolveAnnotationPosition(
      { coords: 'parent', target: { x: 0, y: 0 } },
      [IMG_DELETED, IMG_A, IMG_B],
    )
    expect(pos).toEqual({
      x: 100,
      y: 200,
      parentId: 'img-a',
      relX: 0,
      relY: 0,
    })
  })

  it('case 157', () => {
    expect(() =>
      resolveAnnotationPosition({ coords: 'parent', target: { x: 0.5, y: 0.5 } }, []),
    ).toThrow(/parent.*image/i)
  })

  it('case 158', () => {
    expect(() =>
      resolveAnnotationPosition(
        { coords: 'parent', imageId: 'missing', target: { x: 0.5, y: 0.5 } },
        [IMG_A],
      ),
    ).toThrow(/imageId.*missing/i)
  })
})

describe('suite 5', () => {
  it('case 159', () => {
    const pos = resolveAnnotationPosition(
      { target: { x: 0.5, y: 0.5 } },
      [IMG_A],
    )
    // (100, 200) + (0.5*400, 0.5*300) = (300, 350)
    expect(pos).toEqual({ x: 300, y: 350 })
  })

  it('case 160', () => {
    const pos = resolveAnnotationPosition({ target: { x: 42, y: 84 } }, [])
    expect(pos).toEqual({ x: 42, y: 84 })
  })

  it('case 161', () => {
    const pos = resolveAnnotationPosition(
      { target: { x: 42, y: 84 } },
      [IMG_DELETED],
    )
    expect(pos).toEqual({ x: 42, y: 84 })
  })
})
