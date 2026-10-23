import { describe, expect, it } from 'vitest'
import { nearestInDirection, nextInReadingOrder } from './reading-order.js'

const box = (id: string, x: number, y: number, width = 100, height = 50) => ({
  id,
  x,
  y,
  width,
  height,
})

describe('reading order', () => {
  const walk = (nodes: ReturnType<typeof box>[]) => {
    const seen: string[] = []
    let at: string | null = null
    for (let i = 0; i < nodes.length; i += 1) {
      at = nextInReadingOrder(nodes, at, 1) ?? null
      if (at !== null) seen.push(at)
    }
    return seen
  }

  it('orders top to bottom, then left to right, and breaks a tie by id', () => {
    const nodes = [box('d', 0, 100), box('c', 200, 0), box('b', 0, 0), box('a', 0, 0)]
    expect(walk(nodes)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not mutate its input', () => {
    const nodes = [box('b', 10, 0), box('a', 0, 0)]
    walk(nodes)
    expect(nodes.map((n) => n.id)).toEqual(['b', 'a'])
  })
})

describe('nextInReadingOrder', () => {
  const nodes = [box('a', 0, 0), box('b', 200, 0), box('c', 0, 100)]

  it('starts at the first node going forward and the last going back from nothing', () => {
    expect(nextInReadingOrder(nodes, null, 1)).toBe('a')
    expect(nextInReadingOrder(nodes, null, -1)).toBe('c')
  })

  it('wraps at both ends', () => {
    expect(nextInReadingOrder(nodes, 'c', 1)).toBe('a')
    expect(nextInReadingOrder(nodes, 'a', -1)).toBe('c')
    expect(nextInReadingOrder(nodes, 'a', 1)).toBe('b')
  })

  it('answers undefined for no nodes and starts over when the current id is gone', () => {
    expect(nextInReadingOrder([], null, 1)).toBeUndefined()
    expect(nextInReadingOrder(nodes, 'gone', 1)).toBe('a')
  })
})

describe('nearestInDirection', () => {
  const nodes = [
    box('mid', 200, 200),
    box('right-near', 400, 200),
    box('right-far', 800, 200),
    box('right-off-axis', 400, 600),
    box('below', 200, 400),
    box('left', 0, 200),
    box('above', 200, 0),
  ]

  it('prefers the node on the axis over a nearer-but-offset one', () => {
    expect(nearestInDirection(nodes, 'mid', 'right')).toBe('right-near')
    expect(nearestInDirection(nodes, 'mid', 'left')).toBe('left')
    expect(nearestInDirection(nodes, 'mid', 'down')).toBe('below')
    expect(nearestInDirection(nodes, 'mid', 'up')).toBe('above')
  })

  it('answers undefined when nothing lies that way', () => {
    expect(nearestInDirection(nodes, 'right-far', 'right')).toBeUndefined()
    expect(nearestInDirection(nodes, 'missing', 'right')).toBeUndefined()
  })

  it('breaks an exact tie by id', () => {
    const tied = [box('from', 0, 100), box('b', 300, 0), box('a', 300, 200)]
    expect(nearestInDirection(tied, 'from', 'right')).toBe('a')
  })
})
