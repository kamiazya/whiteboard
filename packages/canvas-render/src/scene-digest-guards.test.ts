// Pins for what the mutation lane found nobody held in `scene-digest.ts`:
// the schema's inner shapes, the gap's symmetry,
// the pairwise and cell-cap boundaries, the containment tie-breaks, the
// free-run order, the empty scene, and a shape without an id beside one with.
// Each case names the edit that leaves every other digest test green.

import type { BoundingBox, Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { sceneDigest, sceneDigestSchema } from './scene-digest.js'

const box = (x: number, y: number, w: number, h: number): BoundingBox => ({ x, y, w, h })

function scene(...boxes: BoundingBox[]): Scene {
  return { nodes: boxes.map((bbox) => ({ kind: 'thematicBreak' as const, bbox })) }
}

function shapes(
  ...nodes: { id?: string; bbox: BoundingBox; truncated?: true; overflows?: true }[]
): Scene {
  return {
    nodes: nodes.map(({ id, bbox, truncated, overflows }) => ({
      kind: 'shape' as const,
      bbox,
      ...(id ? { id } : {}),
      ...(truncated ? { truncated } : {}),
      ...(overflows ? { overflows } : {}),
    })),
  }
}

describe('sceneDigest, the pins the mutation lane asked for', () => {
  it('round-trips a digest that holds an overlap and a containment through the schema', () => {
    // `z.tuple([])` and `z.object({})` are the shape the schema would have
    // if its inner pair and relation were lost; a round-trip over a digest
    // that carries both is the only thing that reads them.
    const digest = sceneDigest(scene(box(0, 0, 100, 100), box(50, 50, 100, 100), box(10, 10, 5, 5)))
    expect(digest.overlaps.length).toBeGreaterThan(0)
    expect(digest.containment.length).toBeGreaterThan(0)
    expect(sceneDigestSchema.parse(digest)).toEqual(digest)
  })

  it('carries a cut node and an overflowing node through the schema as the literal true', () => {
    // `z.literal(true)` is the shape; a literal of the other value would
    // refuse exactly the digest the layout produces, and nothing else reads
    // the two flags off a parsed digest.
    const digest = sceneDigest(
      shapes(
        { id: 'cut', bbox: box(0, 0, 10, 10), truncated: true },
        { id: 'tight', bbox: box(50, 0, 10, 10), overflows: true },
      ),
    )
    expect(digest.nodes).toEqual([
      { id: 'cut', bbox: box(0, 0, 10, 10), z: 0, truncated: true },
      { id: 'tight', bbox: box(50, 0, 10, 10), z: 1, overflows: true },
    ])
    expect(sceneDigestSchema.parse(digest)).toEqual(digest)
  })

  it('orders overlap pairs by their second id when the first ties', () => {
    // Pairs arrive in scene order, so the one with the later second id is
    // generated first; only the tie branch of the pair sort moves it.
    const digest = sceneDigest(
      shapes(
        { id: 'a', bbox: box(0, 0, 100, 100) },
        { id: 'c', bbox: box(90, 0, 20, 20) },
        { id: 'b', bbox: box(0, 90, 20, 20) },
      ),
    )
    expect(digest.overlaps).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ])
  })

  it('measures the gap the same whichever entry is listed first', () => {
    // The right-hand box first: the gap is then `a.x - (b.x + b.w)`, the term
    // every other cluster test leaves at zero by listing boxes left to right.
    const digest = sceneDigest(scene(box(100, 0, 10, 10), box(0, 0, 80, 10)))
    expect(digest.clusters).toEqual([['n0', 'n1']])
  })

  it('picks the code-unit-smaller parent when two candidates tie on area', () => {
    const digest = sceneDigest(
      shapes(
        { id: 'p2', bbox: box(0, 0, 20, 20) },
        { id: 'p1', bbox: box(0, 0, 20, 20) },
        { id: 'c', bbox: box(5, 5, 2, 2) },
      ),
    )
    expect(digest.containment).toEqual([{ parent: 'p1', child: 'c' }])
  })

  it('orders containment by child, not by parent', () => {
    // Children visited b, c, a; parents x, y, z in yet another order — so the
    // unsorted list, the parent-sorted list and the child-sorted list are
    // three different lists.
    const digest = sceneDigest(
      shapes(
        { id: 'z', bbox: box(0, 0, 20, 20) },
        { id: 'b', bbox: box(5, 5, 2, 2) },
        { id: 'x', bbox: box(100, 0, 20, 20) },
        { id: 'c', bbox: box(105, 5, 2, 2) },
        { id: 'y', bbox: box(200, 0, 20, 20) },
        { id: 'a', bbox: box(205, 5, 2, 2) },
      ),
    )
    expect(digest.containment).toEqual([
      { parent: 'y', child: 'a' },
      { parent: 'z', child: 'b' },
      { parent: 'x', child: 'c' },
    ])
  })

  it('never names a box the parent of a second box wearing its own id', () => {
    // A hand-built scene can repeat an id; the larger box strictly contains
    // the smaller, and only the id check keeps `{ parent: 'a', child: 'a' }`
    // out of the digest.
    const digest = sceneDigest(
      shapes({ id: 'a', bbox: box(0, 0, 20, 20) }, { id: 'a', bbox: box(5, 5, 2, 2) }),
    )
    expect(digest.containment).toEqual([])
  })

  it('orders two containments of one child id by parent', () => {
    // Two boxes wearing the same id, each inside a different parent, visited
    // q's first: the child tie is the only thing that puts p's ahead.
    const digest = sceneDigest(
      shapes(
        { id: 'q', bbox: box(100, 0, 20, 20) },
        { id: 'a', bbox: box(105, 5, 2, 2) },
        { id: 'p', bbox: box(0, 0, 20, 20) },
        { id: 'a', bbox: box(5, 5, 2, 2) },
      ),
    )
    expect(digest.containment).toEqual([
      { parent: 'p', child: 'a' },
      { parent: 'q', child: 'a' },
    ])
  })

  it('still computes free regions at exactly the cell budget', () => {
    // 10000px square on a 20px grid is 500 x 500 = 250_000 cells, the budget
    // itself: a bound read one cell too tight drops the regions and says
    // partial for a board the digest promises to answer.
    const digest = sceneDigest(scene(box(0, 0, 20, 20), box(9980, 9980, 20, 20)))
    expect(digest.freeRegions.length).toBeGreaterThan(0)
    expect(digest.partial).toBe(false)
  })

  it('reports the free runs of every row, last row and last column included', () => {
    // Two corner boxes on a 3 x 3 grid: the difference array's stride and
    // its one-past-the-end row are what put the marks of the last row and
    // the last column where the prefix sum reads them.
    const digest = sceneDigest(scene(box(0, 0, 20, 20), box(40, 40, 20, 20)))
    expect(digest.freeRegions).toEqual([box(20, 0, 40, 20), box(0, 20, 60, 20), box(0, 40, 40, 20)])
  })

  it('answers an empty scene with no regions and no caveat', () => {
    const digest = sceneDigest({ nodes: [] })
    expect(digest).toEqual({
      nodes: [],
      overlaps: [],
      containment: [],
      clusters: [],
      freeRegions: [],
      partial: false,
    })
  })

  it('lists two free runs of one row left to right', () => {
    // The grid spans the boxes' union, so the free cells are the two gaps
    // BETWEEN three boxes, never a margin beside the first.
    const digest = sceneDigest(scene(box(0, 0, 20, 20), box(40, 0, 20, 20), box(80, 0, 20, 20)))
    expect(digest.freeRegions).toEqual([box(20, 0, 20, 20), box(60, 0, 20, 20)])
  })

  it('keeps the kept regions in row-then-column order past the region cap', () => {
    // A middle column the full height, so every row past the first splits
    // into a left run and a right run of equal area: 2 x 1001 regions, of
    // which the cap keeps the first 1000 by position — row by row, and left
    // before right within a row.
    const digest = sceneDigest(
      scene(box(20, 0, 20, 1002 * 20), box(0, 0, 20, 20), box(40, 0, 20, 20)),
    )
    expect(digest.partial).toBe(true)
    expect(digest.freeRegions).toHaveLength(1000)
    expect(digest.freeRegions.slice(0, 3)).toEqual([
      box(0, 20, 20, 20),
      box(40, 20, 20, 20),
      box(0, 40, 20, 20),
    ])
  })

  it("puts a row's narrower left run before its wider right run past the region cap", () => {
    // 600 rows, each a 20px run on the left and a 40px run on the right:
    // 1200 regions, so the area sort lists every right run before every
    // left one, and the kept 1000 — all 600 right runs and the first 400
    // left ones — reach the position sort with each row's pair REVERSED.
    // Only the column tie-break puts them back; the capped case above has
    // equal-area runs that the area sort never disturbs.
    const digest = sceneDigest(
      scene(box(20, 0, 20, 601 * 20), box(0, 0, 20, 20), box(40, 0, 40, 20)),
    )
    expect(digest.partial).toBe(true)
    expect(digest.freeRegions).toHaveLength(1000)
    expect(digest.freeRegions.slice(0, 4)).toEqual([
      box(0, 20, 20, 20),
      box(40, 20, 40, 20),
      box(0, 40, 20, 20),
      box(40, 40, 40, 20),
    ])
  })

  it('reports only the identified shapes when at least one shape carries an id', () => {
    const digest = sceneDigest(
      shapes({ id: 'named', bbox: box(0, 0, 10, 10) }, { bbox: box(50, 50, 10, 10) }),
    )
    expect(digest.nodes.map((n) => n.id)).toEqual(['named'])
  })
})
