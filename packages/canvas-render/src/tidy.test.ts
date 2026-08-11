// Tidy = deterministic normalization that respects the author's rough
// topology: outermost-group units, fixed-first-anchor band alignment (no
// running-mean chaining), bounded overlap resolution, locked nodes as
// fixed obstacles. Only boxes that actually move are reported.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import type { TidyNode } from './tidy.js'
import { tidyNodes } from './tidy.js'

const box = (
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 60,
  type: TidyNode['type'] = 'text',
): TidyNode => ({ id, type, x, y, width, height })

const applyMoves = (
  nodes: readonly TidyNode[],
  moves: readonly { id: string; x: number; y: number }[],
) =>
  nodes.map((n) => {
    const m = moves.find((mv) => mv.id === n.id)
    return m === undefined ? n : { ...n, x: m.x, y: m.y }
  })

describe('band alignment', () => {
  it('snaps a rough row to the grid-snapped anchor of its FIRST member', () => {
    const nodes = [box('a', 0, 101), box('b', 200, 118), box('c', 400, 95)]
    const moves = tidyNodes(nodes)
    const after = applyMoves(nodes, [...moves])
    // Sorted by top: c(95) starts the band; a(101) and b(118) join (within
    // 24 of 95). Everyone lands on round8(95) = 96.
    expect(after.map((n) => n.y)).toEqual([96, 96, 96])
  })

  it('never chains: a member joins only within range of the band FIRST anchor', () => {
    // b is within 24 of a, c is within 24 of b but NOT of a — a running
    // mean would drag c in; the fixed-first rule starts a new band at c.
    const nodes = [box('a', 0, 0), box('b', 200, 20), box('c', 400, 40)]
    const moves = tidyNodes(nodes)
    const after = applyMoves(nodes, [...moves])
    expect(after.find((n) => n.id === 'a')?.y).toBe(0)
    expect(after.find((n) => n.id === 'b')?.y).toBe(0)
    expect(after.find((n) => n.id === 'c')?.y).toBe(40)
  })
})

describe('units', () => {
  it('an outermost group scoops nested groups and members as ONE unit', () => {
    // outer contains inner and m; aligning outer with the peer moves all
    // of them by the same delta exactly once.
    const nodes = [
      box('outer', 0, 110, 300, 200, 'group'),
      box('inner', 20, 130, 120, 80, 'group'),
      box('m', 160, 150, 60, 40),
      box('peer', 500, 96, 100, 60),
    ]
    const moves = tidyNodes(nodes)
    const after = applyMoves(nodes, [...moves])
    const dy = (after.find((n) => n.id === 'outer')?.y ?? 0) - 110
    expect(dy).not.toBe(0)
    expect(after.find((n) => n.id === 'inner')?.y).toBe(130 + dy)
    expect(after.find((n) => n.id === 'm')?.y).toBe(150 + dy)
  })
})

describe('overlap resolution', () => {
  it('separates two overlapping singletons deterministically with a margin', () => {
    const nodes = [box('a', 0, 0), box('b', 40, 0)]
    const moves = tidyNodes(nodes)
    const after = applyMoves(nodes, [...moves])
    const a = after.find((n) => n.id === 'a')!
    const b = after.find((n) => n.id === 'b')!
    expect(Math.abs(b.x - a.x)).toBeGreaterThanOrEqual(100 + 24)
    expect(a.y).toBe(b.y)
  })

  it('a locked node never moves; its overlapper moves away instead', () => {
    const nodes = [box('a', 0, 0), box('b', 40, 0)]
    const moves = tidyNodes(nodes, { locked: (id) => id === 'b' })
    const after = applyMoves(nodes, [...moves])
    expect(after.find((n) => n.id === 'b')).toMatchObject({ x: 40, y: 0 })
    const a = after.find((n) => n.id === 'a')!
    expect(a.x + 100 + 24 <= 40 || a.x >= 40 + 100 + 24 || a.y !== 0).toBe(true)
  })
})

describe('scope and totality', () => {
  it('nodes outside the scope stay put', () => {
    const nodes = [box('a', 0, 101), box('b', 200, 118)]
    const moves = tidyNodes(nodes, { scope: new Set(['a']) })
    expect(moves.every((m) => m.id === 'a')).toBe(true)
  })

  it('an already tidy canvas produces no moves', () => {
    const nodes = [box('a', 0, 0), box('b', 200, 0)]
    expect(tidyNodes(nodes)).toEqual([])
  })
})

describe('tidy properties', () => {
  const nodeArb = fc.record({
    x: fc.integer({ min: 0, max: 640 }),
    y: fc.integer({ min: 0, max: 480 }),
    w: fc.constantFrom(60, 100, 140),
    h: fc.constantFrom(40, 60),
  })
  fcTest.prop([fc.array(nodeArb, { minLength: 2, maxLength: 12 })], withDefaults({ numRuns: 80 }))(
    'tidy is idempotent: a second pass moves nothing',
    (rects) => {
      const nodes = rects.map((r, i) => box(`n${i}`, r.x, r.y, r.w, r.h))
      const once = applyMoves(nodes, [...tidyNodes(nodes)])
      expect(tidyNodes(once)).toEqual([])
    },
  )
})
