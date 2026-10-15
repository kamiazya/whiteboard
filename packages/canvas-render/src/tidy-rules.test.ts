// Tidy's narrower rules, each on the side `tidy.test.ts`'s examples leave
// open: which frames scope lets grow, every anchor the margin's yield reads
// on both axes, what makes a hub swap, and who a unit's root claims.
import { describe, expect, it } from 'vitest'
import type { TidyNode } from './tidy.js'
import { tidyNodes } from './tidy.js'

const box = (
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 60,
  frame: TidyNode['frame'] = false,
): TidyNode => ({ id, frame, x, y, width, height })

const edges = (pairs: readonly (readonly [string, string])[]) =>
  pairs.map(([fromNode, toNode]) => ({ from: { node: fromNode }, to: { node: toNode } }))

describe('scope and the frames it lets grow', () => {
  it('a frame neither in scope nor holding anything in scope is not grown', () => {
    const nodes = [
      box('grp', 0, 0, 320, 200, true),
      box('a', 160, 64, 200, 80),
      box('x', 1000, 1000, 100, 60),
      box('y', 1300, 1004, 100, 60),
    ]
    // Unscoped, the frame grows around the member hanging past its edge, so
    // the scoped call below has something to refuse.
    expect(tidyNodes(nodes).some((m) => m.id === 'grp')).toBe(true)
    const moves = tidyNodes(nodes, { scope: new Set(['x', 'y']) })
    expect(moves.filter((m) => m.id === 'grp' || m.id === 'a')).toEqual([])
  })

  it('a lone off-grid box is left where it is', () => {
    // With nothing to line up with or clear, there is nothing to tidy.
    expect(tidyNodes([box('a', 13, 7)])).toEqual([])
  })
})

describe('the margin anchor yields to a row it cannot move', () => {
  // `tidy.test.ts`'s "does not pull a member off a row" lines the member up
  // with an outside box's NEAR edge on x. Every anchor the bands and the
  // drawing score read counts, on both axes.
  const pipelineScope = new Set(['ingest', 'transform', 'publish'])

  it.each([
    ['centre', -100],
    ['far edge', -200],
  ])("a member lined up with an outside box's %s keeps its column", (_anchor, outsideX) => {
    const nodes = [
      box('outside', outsideX, 0, 200, 80),
      box('grp', -40, 260, 880, 160, true),
      box('ingest', 0, 296, 200, 80),
      box('transform', 304, 296, 200, 80),
      box('publish', 600, 296, 200, 80),
    ]
    const moves = tidyNodes(nodes, { scope: pipelineScope })
    expect(moves.find((m) => m.id === 'ingest')).toBeUndefined()
  })

  it.each([
    ['near edge', 0],
    ['centre', -100],
    ['far edge', -200],
  ])("a member lined up with an outside box's %s keeps its row", (_anchor, outsideY) => {
    const nodes = [
      box('outside', 0, outsideY, 80, 200),
      box('grp', 260, -40, 160, 880, true),
      box('ingest', 296, 0, 80, 200),
      box('transform', 296, 304, 80, 200),
      box('publish', 296, 600, 80, 200),
    ]
    const moves = tidyNodes(nodes, { scope: pipelineScope })
    expect(moves.find((m) => m.id === 'ingest')).toBeUndefined()
  })

  // Across two frames: what the margin rule cannot move is decided by scope
  // and lock, not only by whether a frame holds the box.
  const twoFrames = () => [
    box('grp-a', -32, -40, 880, 160, true),
    box('outside', 0, 0, 200, 80),
    box('grp', -40, 260, 880, 160, true),
    box('ingest', 0, 296, 200, 80),
    box('transform', 304, 296, 200, 80),
    box('publish', 600, 296, 200, 80),
  ]

  it("yields to another frame's member the scope leaves where it is", () => {
    const moves = tidyNodes(twoFrames(), { scope: pipelineScope })
    expect(moves.find((m) => m.id === 'ingest')).toBeUndefined()
  })

  it("yields to another frame's LOCKED member", () => {
    const moves = tidyNodes(twoFrames(), { locked: (id) => id === 'outside' || id === 'grp-a' })
    expect(moves.find((m) => m.id === 'ingest')?.x ?? 0).toBe(0)
  })
})

describe('what makes a hub swap', () => {
  // The swap is about which way the connections LIE, not which way they
  // point, the order they are listed in, or what else the hub is tied to.
  const fanRow = () => [
    box('hub', 40, 0, 160, 60),
    box('near', 264, 0, 160, 60),
    box('far', 488, 0, 160, 60),
  ]
  const hubSwapped = [
    { id: 'hub', x: 264, y: 0 },
    { id: 'near', x: 40, y: 0 },
  ]

  it('a hub whose row connections point INTO it swaps the same way', () => {
    const moves = tidyNodes(fanRow(), {
      edges: edges([
        ['near', 'hub'],
        ['far', 'hub'],
      ]),
    })
    expect(moves).toEqual(hubSwapped)
  })

  it('swaps with the NEAREST partner whatever order the edges are listed in', () => {
    const moves = tidyNodes(fanRow(), {
      edges: edges([
        ['hub', 'far'],
        ['hub', 'near'],
      ]),
    })
    expect(moves).toEqual(hubSwapped)
  })

  it('a self-loop does not stop a hub from swapping', () => {
    const moves = tidyNodes(fanRow(), {
      edges: edges([
        ['hub', 'hub'],
        ['hub', 'near'],
        ['hub', 'far'],
      ]),
    })
    expect(moves).toEqual(hubSwapped)
  })

  // A partner touching the hub edge-to-edge already lies to that side, so
  // the swap happens on the pass that sees it rather than after the overlap
  // pass has pushed the pair apart — which lands both somewhere else.
  it('a partner touching the hub on its right counts as lying to the right', () => {
    const nodes = [
      box('hub', 40, 0, 160, 60),
      box('near', 200, 0, 160, 60),
      box('far', 488, 0, 160, 60),
    ]
    const moves = tidyNodes(nodes, {
      edges: edges([
        ['hub', 'near'],
        ['hub', 'far'],
      ]),
    })
    expect(moves).toEqual([
      { id: 'hub', x: 200, y: 0 },
      { id: 'near', x: 8, y: 0 },
    ])
  })

  it('a partner touching the hub on its left counts as lying to the left', () => {
    const nodes = [
      box('far', 40, 0, 160, 60),
      box('near', 264, 0, 160, 60),
      box('hub', 424, 0, 160, 60),
    ]
    const moves = tidyNodes(nodes, {
      edges: edges([
        ['hub', 'near'],
        ['hub', 'far'],
      ]),
    })
    expect(moves).toEqual([
      { id: 'near', x: 424, y: 0 },
      { id: 'hub', x: 232, y: 0 },
    ])
  })
})

describe('who a unit root claims', () => {
  it('a frame another frame claims is its member, not a second unit for the boxes past it', () => {
    // `inner` is no group's full contents, so it is a root by the rule, but
    // `outer` claimed it first. The box inside `inner` and past `outer`'s
    // edge is then a singleton; scooping it under the claimed frame grows a
    // frame that is somebody else's member and carries the box off its row.
    const nodes = [
      box('outer', 0, 0, 400, 200, true),
      box('inner', 200, 0, 300, 200, true),
      box('n', 420, 50, 60, 60),
    ]
    const moves = tidyNodes(nodes)
    // It rides with its owner, ungrown.
    expect(moves.find((m) => m.id === 'inner')).toEqual({ id: 'inner', x: 200, y: 32 })
    expect(moves.find((m) => m.id === 'n')?.y).toBe(48)
  })
})
