// Frame nesting is resolved once per settle pass and walked with an explicit
// stack, where it used to be re-derived at every level by recursion. That is
// a cost change and nothing else, so the production tidy is held to a frozen
// copy of the recursive one on boards built to nest: frames inside frames,
// frames with IDENTICAL boxes (the document-order tie), frames and boxes
// straddling an edge, locks and scopes that hold a level still.
//
// What the two share is the passes inside a level (`tidy-axis`, `tidy-bands`)
// and `fullyContains`, none of which this change touches; what differs is
// exactly who is a level's root and the order levels are visited in.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { tidyNodes as referenceTidyNodes } from './test-utils/tidy-reference/tidy.js'
import { type TidyNode, type TidyOptions, tidyNodes } from './tidy.js'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** How a box is placed against the one it is drawn relative to. */
type Placement = 'inside' | 'same' | 'straddle' | 'free'

const placement = fc.constantFrom<Placement>(
  'inside',
  'inside',
  'inside',
  'same',
  'straddle',
  'free',
)

function place(parent: Box | undefined, how: Placement, [a, b, c, d]: readonly number[]): Box {
  if (parent === undefined || how === 'free') {
    return { x: a * 8 - 400, y: b * 8 - 400, width: 40 + c * 4, height: 40 + d * 4 }
  }
  if (how === 'same')
    return { x: parent.x, y: parent.y, width: parent.width, height: parent.height }
  if (how === 'straddle') {
    return { x: parent.x + parent.width - 20, y: parent.y + b, width: 40 + c, height: 40 + d }
  }
  const left = Math.min(a, Math.floor(parent.width / 3))
  const top = Math.min(b, Math.floor(parent.height / 3))
  return {
    x: parent.x + left,
    y: parent.y + top,
    width: Math.max(1, parent.width - left - Math.min(c, Math.floor(parent.width / 3))),
    height: Math.max(1, parent.height - top - Math.min(d, Math.floor(parent.height / 3))),
  }
}

const spec = fc.record({
  parent: fc.nat(),
  how: placement,
  dims: fc.array(fc.nat({ max: 100 }), { minLength: 4, maxLength: 4 }),
  frame: fc.boolean(),
  order: fc.nat(),
})

const board = fc
  .record({
    root: fc.array(fc.nat({ max: 100 }), { minLength: 4, maxLength: 4 }),
    rest: fc.array(spec, { minLength: 1, maxLength: 14 }),
  })
  .map(({ root, rest }) => {
    const rootBox = { x: 0, y: 0, width: 600 + root[0]! * 4, height: 600 + root[1]! * 4 }
    const nodes: (TidyNode & { order: number })[] = [
      { id: 'n00', frame: true, ...rootBox, order: root[2]! },
    ]
    for (const [i, s] of rest.entries()) {
      // Every node is drawn against an earlier FRAME, so the chain of frames
      // a node sits inside can be as deep as the board is long.
      const frames = nodes.filter((n) => n.frame)
      const parent = frames[s.parent % frames.length]
      nodes.push({
        id: `n${String(i + 1).padStart(2, '0')}`,
        frame: s.frame,
        ...place(parent, s.how, s.dims),
        order: s.order,
      })
    }
    return [...nodes]
      .sort((p, q) => p.order - q.order)
      .map(({ order: _order, ...node }): TidyNode => node)
  })

const options = (ids: readonly string[]): fc.Arbitrary<TidyOptions> =>
  fc
    .record({
      locked: fc.option(fc.subarray([...ids], { maxLength: 2 }), { nil: undefined }),
      scope: fc.option(fc.subarray([...ids]), { nil: undefined }),
      edges: fc.option(
        fc.array(fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids)), { maxLength: 6 }),
        { nil: undefined },
      ),
    })
    .map(({ locked, scope, edges }) => ({
      ...(locked === undefined ? {} : { locked: (id: string) => locked.includes(id) }),
      ...(scope === undefined ? {} : { scope: new Set(scope) }),
      ...(edges === undefined
        ? {}
        : { edges: edges.map(([from, to]) => ({ from: { node: from }, to: { node: to } })) }),
    }))

const boardWithOptions = board.chain((nodes) =>
  options(nodes.map((n) => n.id)).map((opts) => ({ nodes, opts })),
)

/** How many frames deep the deepest box sits — the walk this guards. */
function depth(nodes: readonly TidyNode[]): number {
  const frames = nodes.filter((n) => n.frame)
  const inside = (outer: TidyNode, inner: TidyNode) =>
    outer !== inner &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  return Math.max(...nodes.map((n) => frames.filter((f) => inside(f, n)).length))
}

describe('tidy over nested frames matches the recursive walk it replaced', () => {
  fcTest.prop([boardWithOptions], withDefaults({ numRuns: 300 }))(
    'moves every node exactly as the frozen reference does',
    ({ nodes, opts }) => {
      expect(tidyNodes(nodes, opts)).toEqual(referenceTidyNodes(nodes, opts))
    },
  )

  it('draws boards that actually nest, tie and move', () => {
    // The property is vacuous on boards with no depth, or ones tidy leaves
    // alone; these floors say the generator reaches what it is there for.
    // Measured over five samples: deep 127-158, tied 141-167, moved 299-312.
    const sample = fc.sample(boardWithOptions, 400)
    // Twin frames that share an id are not twins to the tie-break, which
    // skips a frame's own id; a generator copying the parent whole drew
    // exactly that, and left the tie unjudged on all but 3 boards in 2000.
    expect(sample.every(({ nodes }) => new Set(nodes.map((n) => n.id)).size === nodes.length)).toBe(
      true,
    )
    const deep = sample.filter(({ nodes }) => depth(nodes) >= 3).length
    const tied = sample.filter(({ nodes }) => {
      const frames = nodes.filter((n) => n.frame)
      const keys = frames.map((f) => `${f.x} ${f.y} ${f.width} ${f.height}`)
      return new Set(keys).size < keys.length
    }).length
    const moved = sample.filter(({ nodes, opts }) => tidyNodes(nodes, opts).length > 0).length
    expect(deep).toBeGreaterThan(80)
    expect(tied).toBeGreaterThan(80)
    expect(moved).toBeGreaterThan(200)
  })
})
