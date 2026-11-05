// A board of frames holding notes — a retrospective's three columns, a
// kanban — is the commonest shape a person tidies, and the two promises a
// reader checks first are that a note stays in the frame it was put in and
// that the frames do not end up on top of one another.
//
// Membership is geometric: a node more than half inside a frame before the
// tidy belongs to it, and must be wholly inside it after.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { type TidyNode, tidyNodes } from './tidy.js'

const frame = (id: string, x: number, y: number, width: number, height: number): TidyNode => ({
  id,
  frame: true,
  x,
  y,
  width,
  height,
})
const note = (id: string, x: number, y: number, width = 200, height = 100): TidyNode => ({
  id,
  frame: false,
  x,
  y,
  width,
  height,
})

function applyTidy(nodes: readonly TidyNode[]): TidyNode[] {
  const moves = tidyNodes(nodes)
  return nodes.map((n) => {
    const m = moves.find((mv) => mv.id === n.id)
    return m === undefined
      ? n
      : { ...n, x: m.x, y: m.y, width: m.width ?? n.width, height: m.height ?? n.height }
  })
}

const holds = (outer: TidyNode, inner: TidyNode) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/** Written out rather than imported: the oracle shares no code with tidy. */
function mostlyIn(outer: TidyNode, inner: TidyNode): boolean {
  const w = Math.min(outer.x + outer.width, inner.x + inner.width) - Math.max(outer.x, inner.x)
  const h = Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y)
  return w > 0 && h > 0 && 2 * w * h > inner.width * inner.height
}

const overlaps = (a: TidyNode, b: TidyNode) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Every (frame, node) pair whose membership the tidy broke, by id. */
function membershipLost(before: readonly TidyNode[], after: readonly TidyNode[]): string[] {
  const at = new Map(after.map((n) => [n.id, n]))
  const lost: string[] = []
  for (const f of before) {
    if (!f.frame) continue
    for (const n of before) {
      if (n.id === f.id || !mostlyIn(f, n)) continue
      if (!holds(at.get(f.id) as TidyNode, at.get(n.id) as TidyNode)) lost.push(`${n.id} ${f.id}`)
    }
  }
  return lost
}

/** Frame pairs that overlap where neither holds the other. */
function framesOverlapping(after: readonly TidyNode[]): string[] {
  const frames = after.filter((n) => n.frame)
  const pairs: string[] = []
  for (const [i, a] of frames.entries()) {
    for (const b of frames.slice(i + 1)) {
      if (overlaps(a, b) && !holds(a, b) && !holds(b, a)) pairs.push(`${a.id} ${b.id}`)
    }
  }
  return pairs
}

/**
 * The retrospective a person built by hand in the editor: three frames,
 * notes dropped in touching each other, one note grouped on its own — which
 * puts its frame FIRST in document order, since a new frame goes to the
 * bottom of the z-order — straddling its column's lower edge, and one note
 * left mostly outside the Actions frame. Read off the screen at zoom 0.84.
 */
const retrospective: readonly TidyNode[] = [
  frame('flaky-ci-group', 796, 664, 249, 149),
  frame('went-well', 29, 443, 511, 354),
  frame('to-improve', 605, 443, 512, 354),
  frame('actions', 1173, 436, 513, 352),
  note('teamwork', 40, 452),
  note('deploys', 240, 452),
  note('demo', 40, 570),
  note('tickets', 240, 570),
  note('pairing', 40, 689),
  note('slow-ci', 300, 680),
  note('flaky', 620, 452),
  note('review', 821, 452),
  note('specs', 620, 570),
  note('meetings', 821, 570),
  note('flaky-ci', 821, 689),
  note('sla', 1381, 379),
  note('fix', 1181, 443),
  note('spec', 1181, 562),
  note('standups', 1381, 562),
  note('cache', 1181, 680),
]

describe('tidy on a board of frames holding notes', () => {
  it('keeps every note in its frame and the frames apart on a retrospective', () => {
    const after = applyTidy(retrospective)
    expect(membershipLost(retrospective, after)).toEqual([])
    expect(framesOverlapping(after)).toEqual([])
  })

  it('keeps a retrospective column on its row while its notes settle', () => {
    // A frame's top-left is its alignment with its peers: notes hopping
    // up past the margin grew the middle column 275px above the others.
    const after = applyTidy(retrospective)
    const tops = ['went-well', 'to-improve', 'actions'].map(
      (id) => after.find((n) => n.id === id)?.y,
    )
    expect(new Set(tops).size).toBe(1)
  })
})

interface ColumnSpec {
  readonly notes: number
  readonly gapX: number
  readonly gapY: number
  readonly jitter: readonly (readonly [number, number])[]
  /** Group one note on its own, the way "Group selection" does. */
  readonly grouped: boolean
}

const column = fc.record({
  notes: fc.integer({ min: 3, max: 7 }),
  // Touching, overlapping and comfortably apart: the drop gesture gives all three.
  gapX: fc.integer({ min: -24, max: 48 }),
  gapY: fc.integer({ min: -24, max: 48 }),
  jitter: fc.array(fc.tuple(fc.integer({ min: -16, max: 16 }), fc.integer({ min: -16, max: 16 })), {
    minLength: 7,
    maxLength: 7,
  }),
  grouped: fc.boolean(),
})

function buildBoard(columns: readonly ColumnSpec[], frameGap: number, order: readonly number[]) {
  const nodes: TidyNode[] = []
  const groups: TidyNode[] = []
  let x = 0
  for (const [c, spec] of columns.entries()) {
    const cellW = 200 + spec.gapX
    const cellH = 100 + spec.gapY
    const rows = Math.ceil(spec.notes / 2)
    const width = 24 + 2 * cellW
    const height = 24 + rows * cellH
    nodes.push(frame(`f${c}`, x, 0, width, height))
    for (let i = 0; i < spec.notes; i++) {
      const [jx, jy] = spec.jitter[i] ?? [0, 0]
      nodes.push(
        note(`n${c}-${i}`, x + 12 + (i % 2) * cellW + jx, 12 + Math.floor(i / 2) * cellH + jy),
      )
    }
    if (spec.grouped) {
      // Around the column's last note, hanging past the column's lower edge.
      const last = nodes.at(-1) as TidyNode
      groups.push(frame(`g${c}`, last.x - 12, last.y - 12, last.width + 24, last.height + 40))
    }
    x += width + frameGap
  }
  // Notes keep the order they were made in, shuffled; a group frame goes to
  // the bottom of the z-order, ahead of everything.
  const shuffled = nodes
    .map((n, i) => ({ n, key: order[i % order.length] ?? 0 }))
    .sort((a, b) => a.key - b.key)
    .map(({ n }) => n)
  return [...groups, ...shuffled]
}

const board = fc
  .record({
    columns: fc.array(column, { minLength: 2, maxLength: 4 }),
    frameGap: fc.integer({ min: 8, max: 96 }),
    order: fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 30 }),
  })
  .map(({ columns, frameGap, order }) => buildBoard(columns, frameGap, order))

describe('tidy on a generated board of frames holding notes', () => {
  fcTest.prop([board], withDefaults({ numRuns: 200 }))(
    'never moves a node out of its frame nor leaves two frames overlapping',
    (nodes) => {
      const after = applyTidy(nodes)
      expect(membershipLost(nodes, after)).toEqual([])
      expect(framesOverlapping(after)).toEqual([])
    },
  )

  it('draws boards with a straddling group and notes too close to keep', () => {
    // Without these two the property passes on boards tidy has nothing to
    // do with. Measured over five samples of 300: grouped 245-267, crowded
    // 300 every time.
    const sample = fc.sample(board, 300)
    const grouped = sample.filter((nodes) => nodes.some((n) => n.id.startsWith('g'))).length
    const crowded = sample.filter((nodes) => tidyNodes(nodes).length > 0).length
    expect(grouped).toBeGreaterThan(200)
    expect(crowded).toBeGreaterThan(270)
  })
})
