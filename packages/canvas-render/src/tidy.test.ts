// Tidy = deterministic normalization that respects the author's rough
// topology: outermost-group units, fixed-first-anchor band alignment (no
// running-mean chaining), bounded overlap resolution, locked nodes as
// fixed obstacles. Only boxes that actually move are reported.
import { afterAll, describe, expect, it } from 'vitest'
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

const TIDY_MARGIN_PX = 24
const TIDY_GRID_PX = 8

const rectOf = (n: TidyNode) => ({ x: n.x, y: n.y, w: n.width, h: n.height })
const overlapsWithMargin = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
  a.x < b.x + b.w + TIDY_MARGIN_PX &&
  b.x < a.x + a.w + TIDY_MARGIN_PX &&
  a.y < b.y + b.h + TIDY_MARGIN_PX &&
  b.y < a.y + a.h + TIDY_MARGIN_PX

describe('tidy properties', () => {
  const nodeArb = fc.record({
    x: fc.integer({ min: 0, max: 640 }),
    y: fc.integer({ min: 0, max: 480 }),
    w: fc.constantFrom(60, 100, 140),
    h: fc.constantFrom(40, 60),
  })
  const plainNodes = (rects: readonly { x: number; y: number; w: number; h: number }[]) =>
    rects.map((r, i) => box(`n${i}`, r.x, r.y, r.w, r.h))

  fcTest.prop([fc.array(nodeArb, { minLength: 2, maxLength: 12 })], withDefaults({ numRuns: 80 }))(
    'tidy is idempotent: a second pass moves nothing',
    (rects) => {
      const nodes = plainNodes(rects)
      const once = applyMoves(nodes, [...tidyNodes(nodes)])
      expect(tidyNodes(once)).toEqual([])
    },
  )

  fcTest.prop([fc.array(nodeArb, { minLength: 2, maxLength: 12 })], withDefaults({ numRuns: 80 }))(
    'nothing is left overlapping, which is what the whole pass is for',
    (rects) => {
      // Idempotence alone is satisfied by a tidy that does NOTHING, and
      // separation is the reason the module exists. Stated over plain
      // singletons, because two members of one group unit are allowed to
      // overlap each other — the unit moves as a whole.
      const nodes = plainNodes(rects)
      const after = applyMoves(nodes, [...tidyNodes(nodes)])
      const collisions = after.flatMap((a, i) =>
        after.slice(i + 1).filter((b) => overlapsWithMargin(rectOf(a), rectOf(b))),
      )
      expect(collisions).toEqual([])
    },
  )

  fcTest.prop([fc.array(nodeArb, { minLength: 2, maxLength: 12 })], withDefaults({ numRuns: 80 }))(
    'every position it emits sits ON the grid',
    (rects) => {
      // Both movers land on the grid — banding snaps to it, and an overlap hop
      // rounds AWAY from the collider onto it. Off-grid output would feed the
      // next pass's banding and unsettle the fixpoint, so this is part of why
      // idempotence holds rather than an independent nicety.
      const offGrid = [...tidyNodes(plainNodes(rects))].filter(
        (m) => m.x % TIDY_GRID_PX !== 0 || m.y % TIDY_GRID_PX !== 0,
      )
      expect(offGrid).toEqual([])
    },
  )

  fcTest.prop([fc.array(nodeArb, { minLength: 2, maxLength: 12 })], withDefaults({ numRuns: 80 }))(
    'it reports only nodes that actually moved',
    (rects) => {
      const nodes = plainNodes(rects)
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const noOps = [...tidyNodes(nodes)].filter(
        (m) => byId.get(m.id)?.x === m.x && byId.get(m.id)?.y === m.y,
      )
      expect(noOps).toEqual([])
    },
  )

  /**
   * Groups, locks and scope — none of which the plain domain above can
   * produce, and which between them own most of this module. A group only
   * scoops what its box CONTAINS, so the enclosing box is computed from the
   * members rather than drawn: independently drawn boxes contain one another
   * almost never, and the scooping would go untested exactly as it did.
   */
  const scenarioArb = fc
    .record({
      rects: fc.array(nodeArb, { minLength: 2, maxLength: 8 }),
      grouped: fc.integer({ min: 0, max: 4 }),
      locked: fc.integer({ min: 0, max: 2 }),
      scoped: fc.boolean(),
    })
    .map(({ rects, grouped, locked, scoped }) => {
      const members = plainNodes(rects)
      const wrapped = members.slice(0, Math.min(grouped, members.length))
      const nodes: TidyNode[] = [...members]
      if (wrapped.length >= 2) {
        const x = Math.min(...wrapped.map((n) => n.x))
        const y = Math.min(...wrapped.map((n) => n.y))
        const right = Math.max(...wrapped.map((n) => n.x + n.width))
        const bottom = Math.max(...wrapped.map((n) => n.y + n.height))
        nodes.unshift(box('grp', x, y, right - x, bottom - y, 'group'))
      }
      const lockedIds = new Set(nodes.slice(0, locked).map((n) => n.id))
      const scope = scoped
        ? new Set(nodes.filter((_, i) => i % 2 === 0).map((n) => n.id))
        : undefined
      return { nodes, lockedIds, scope }
    })

  const tidyScenario = ({
    nodes,
    lockedIds,
    scope,
  }: {
    nodes: TidyNode[]
    lockedIds: Set<string>
    scope: Set<string> | undefined
  }) =>
    tidyNodes(nodes, {
      locked: (id) => lockedIds.has(id),
      ...(scope === undefined ? {} : { scope }),
    })

  // What the scenario domain actually reached, guarded from both sides. A
  // property over groups that never generates a group passes for the wrong
  // reason, and reads exactly like one that does. Measured over 120 runs:
  // a group node in 65, a lock in 77, a scope in 61, and some move emitted in
  // 96 — so the floor is far below each without pinning a distribution.
  const REACHED = {
    group: 'the board contains a group node, whose box scoops members',
    locked: 'at least one id is locked',
    scope: 'a scope is supplied, so some units are immobile',
    moved: 'the pass emitted at least one move',
  } as const
  const reached = new Map<string, number>()
  const REACHED_FLOOR = 10
  const note = (key: keyof typeof REACHED, hit: boolean) => {
    if (hit) reached.set(key, (reached.get(key) ?? 0) + 1)
  }
  afterAll(() => {
    expect(
      Object.fromEntries(
        Object.keys(REACHED).map((key) => [key, (reached.get(key) ?? 0) >= REACHED_FLOOR]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(REACHED).map((key) => [key, true])))
  })

  fcTest.prop([scenarioArb], withDefaults({ numRuns: 120 }))(
    'a locked node is never moved',
    (scenario) => {
      const moves = tidyScenario(scenario)
      note(
        'group',
        scenario.nodes.some((n) => n.type === 'group'),
      )
      note('locked', scenario.lockedIds.size > 0)
      note('scope', scenario.scope !== undefined)
      note('moved', moves.length > 0)

      expect(moves.filter((m) => scenario.lockedIds.has(m.id))).toEqual([])
    },
  )

  fcTest.prop([scenarioArb], withDefaults({ numRuns: 120 }))(
    'tidy is deterministic — the same board yields the same moves',
    (scenario) => {
      expect(tidyScenario(scenario)).toEqual(tidyScenario(scenario))
    },
  )

  fcTest.prop(
    [fc.array(nodeArb, { minLength: 2, maxLength: 8 }), fc.nat({ max: 7 })],
    withDefaults({ numRuns: 80 }),
  )('a node with non-finite geometry is dropped, and the rest still tidy', (rects, which) => {
    // `usable` exists for exactly this, and nothing generated one: a stored
    // canvas can hold a NaN coordinate, and the pass must not turn into NaN
    // moves because of it.
    const nodes = plainNodes(rects)
    const index = which % nodes.length
    const broken = nodes.map((n, i) => (i === index ? { ...n, x: Number.NaN } : n))
    const moves = tidyNodes(broken)

    expect(moves.some((m) => m.id === nodes[index]?.id)).toBe(false)
    expect(moves.every((m) => Number.isFinite(m.x) && Number.isFinite(m.y))).toBe(true)
  })
})
