import { describe, expect, it } from 'vitest'
import { MIN_SCENE_EXTENT_PX, sceneBounds } from './scene-bounds.js'
import type { Scene } from './scene-graph.js'

describe('sceneBounds', () => {
  it('returns the documented fallback for an empty scene', () => {
    const scene: Scene = { nodes: [] }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('returns exactly one node bbox when the scene has a single non-degenerate node', () => {
    const scene: Scene = {
      nodes: [{ kind: 'thematicBreak', bbox: { x: 10, y: 20, w: 100, h: 5 } }],
    }
    expect(sceneBounds(scene)).toEqual({ x: 10, y: 20, w: 100, h: 5 })
  })

  it('unions two disjoint nodes, including negative coordinates', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: -50, y: -10, w: 10, h: 10 } },
        { kind: 'thematicBreak', bbox: { x: 100, y: 50, w: 20, h: 20 } },
      ],
    }
    // union spans from (-50,-10) to (120,70)
    expect(sceneBounds(scene)).toEqual({ x: -50, y: -10, w: 170, h: 80 })
  })

  it('clamps a zero-size scene to the minimum extent while preserving position', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 5, y: 5, w: 0, h: 0 } },
        { kind: 'thematicBreak', bbox: { x: 5, y: 5, w: 0, h: 0 } },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(5)
    expect(bounds.y).toBe(5)
    expect(bounds.w).toBe(MIN_SCENE_EXTENT_PX)
    expect(bounds.h).toBe(MIN_SCENE_EXTENT_PX)
  })

  it('normalizes a negative w/h bbox rather than trusting it as an extent', () => {
    const scene: Scene = {
      nodes: [{ kind: 'thematicBreak', bbox: { x: 100, y: 100, w: -50, h: -20 } }],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(50)
    expect(bounds.y).toBe(80)
    expect(bounds.w).toBe(50)
    expect(bounds.h).toBe(20)
  })

  it('skips a bbox with a non-finite field, keeping the rest of the scene', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: Number.NaN, y: 0, w: 10, h: 10 } },
        { kind: 'thematicBreak', bbox: { x: 200, y: 200, w: 10, h: 10 } },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 200, y: 200, w: 10, h: 10 })
  })

  it('falls back to the documented default when every bbox is non-finite', () => {
    const scene: Scene = {
      nodes: [{ kind: 'thematicBreak', bbox: { x: Number.POSITIVE_INFINITY, y: 0, w: 10, h: 10 } }],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('derives bounds from edge path points, ignoring an empty path', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 50, y: 30 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'none',
        },
        {
          kind: 'edge',
          id: 'e2',
          path: [],
          fromSide: 'top',
          toSide: 'bottom',
          fromEnd: 'none',
          toEnd: 'none',
        },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 50, h: 30 })
  })

  it('skips an edge point with only ONE non-finite coordinate', () => {
    // The bbox path already covers a non-finite field; the POINT path did not,
    // and its guard is a conjunction — so `||` in place of `&&` admits a point
    // whose x is NaN, and the whole extent becomes NaN. A point where BOTH
    // coordinates are non-finite cannot tell the two apart.
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 100, y: 50 },
            { x: Number.NaN, y: 1000 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'none',
        },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 100, h: 50 })
  })

  it('leaves a wrapper that emits NO transform absolute', () => {
    // Only `listItem` and `tableCell` translate their subtree. A group at
    // x=100 whose child sits at x=0 must contribute BOTH — reading the group's
    // own x as an offset shifts the child onto the group and loses everything
    // to its left.
    const scene: Scene = {
      nodes: [
        {
          kind: 'group',
          bbox: { x: 100, y: 0, w: 10, h: 10 },
          children: [{ kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 10, h: 10 } }],
        },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 110, h: 10 })
  })

  it('walks the runs of a PARAGRAPH, not only those of a heading', () => {
    // `heading`, `paragraph` and `tableCell` share one case arm, so a test for
    // any single one of them leaves the other two able to fall through to
    // `default` — where the runs are never visited and a run outside its
    // parent silently stops counting.
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          runs: [
            {
              kind: 'textRun',
              bbox: { x: 0, y: 0, w: 200, h: 16 },
              baseline: 12,
              text: 'wider than its parent',
            },
          ],
        },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 200, h: 16 })
  })

  it('applies a list-item offset to a nested EDGE, whose points are item-relative', () => {
    // The same wrapper-relative rule the shape and run cases already pin, on
    // the third and last kind of geometry the walk knows — an edge's points.
    // Its two loops (polyline and arrowhead wings) compose the offset with the
    // same `+`, and nothing reached either of them under a transform.
    const scene: Scene = {
      nodes: [
        {
          kind: 'list',
          bbox: { x: 50, y: 0, w: 10, h: 10 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: 50, y: 0, w: 10, h: 10 },
              children: [
                {
                  kind: 'edge',
                  id: 'nested',
                  path: [
                    { x: 0, y: 0 },
                    { x: 20, y: 30 },
                  ],
                  fromSide: 'right',
                  toSide: 'left',
                  fromEnd: 'none',
                  toEnd: 'none',
                },
              ],
            },
          ],
        },
      ],
    }
    // The item translates its subtree by its own x, so the points land at
    // x = 50 and x = 70; the list and item bboxes span 50..60.
    expect(sceneBounds(scene)).toEqual({ x: 50, y: 0, w: 20, h: 30 })
  })

  it('applies that offset to the arrowhead WINGS too, not only the polyline', () => {
    // The walk has two point loops — the path and the arrow polygons — and
    // each composes the offset itself. The test above reaches only the first,
    // because an edge with no arrowhead has no wings. Asserted as a shift
    // rather than as coordinates: the wing geometry is the arrow helper's
    // business, and pinning its numbers here would break on every change to
    // the arrow shape while saying nothing about the offset.
    const arrowEdge = {
      kind: 'edge' as const,
      id: 'arrowed',
      path: [
        { x: 0, y: 0 },
        { x: 20, y: 30 },
      ],
      fromSide: 'right' as const,
      toSide: 'left' as const,
      fromEnd: 'none' as const,
      toEnd: 'arrow' as const,
    }
    const nest = (offsetX: number): Scene => ({
      nodes: [
        {
          kind: 'list',
          bbox: { x: offsetX, y: 0, w: 1, h: 1 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: offsetX, y: 0, w: 1, h: 1 },
              children: [arrowEdge],
            },
          ],
        },
      ],
    })

    const here = sceneBounds(nest(0))
    const shifted = sceneBounds(nest(50))

    expect(shifted.x).toBe(here.x + 50)
    expect(shifted.w).toBe(here.w)
  })

  it('skips a non-finite arrowhead point, exactly as it skips a path point', () => {
    // An arrowhead is derived FROM the path, so a non-finite path point can
    // produce non-finite wings — and the wings have their own guard. Without
    // it the whole extent goes NaN and the SVG gets a viewBox of NaNs.
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'broken',
          path: [
            { x: 0, y: 0 },
            { x: 100, y: 50 },
            { x: Number.NaN, y: Number.NaN },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
        },
      ],
    }
    const bounds = sceneBounds(scene)

    expect(Number.isFinite(bounds.x)).toBe(true)
    expect(Number.isFinite(bounds.y)).toBe(true)
    expect(Number.isFinite(bounds.w)).toBe(true)
    expect(Number.isFinite(bounds.h)).toBe(true)
  })

  it('includes arrowhead wings in the bounds so a derived viewBox never clips them', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
        },
      ],
    }
    // The horizontal polyline alone spans y [0, 0]; the destination arrow's
    // wings reach y = -4 and y = 4 at x = 20.
    expect(sceneBounds(scene)).toEqual({ x: 0, y: -4, w: 30, h: 8 })
  })

  it('widens the bounds when a nested descendant lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'group',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when a blockquote child lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'blockquote',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when an embedResolved child lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'embedResolved',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          documentId: 'other-canvas',
          children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when a listItem child lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'list',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: 0, y: 0, w: 10, h: 10 },
              children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
            },
          ],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when a table cell run lies outside its row/cell bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'table',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          rows: [
            {
              kind: 'tableRow',
              bbox: { x: 0, y: 0, w: 10, h: 10 },
              cells: [
                {
                  kind: 'tableCell',
                  bbox: { x: 0, y: 0, w: 10, h: 10 },
                  runs: [
                    {
                      kind: 'textRun',
                      bbox: { x: 500, y: 500, w: 10, h: 10 },
                      text: 'wide',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when a heading run lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'heading',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          level: 1,
          runs: [{ kind: 'textRun', bbox: { x: 500, y: 500, w: 10, h: 10 }, text: 'wide' }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  // `renderTableCell` and `renderListItem` are the only two renderers that
  // emit a transform, translating their subtree by the wrapper's own bbox.x.
  // Their descendants are therefore stored in wrapper-relative coordinates,
  // and bounds computed without re-applying that offset can place the
  // viewBox short of what actually gets drawn — clipping the overflow.
  it('applies the table-cell offset to its runs, which are cell-relative', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'table',
          bbox: { x: 0, y: 0, w: 20, h: 10 },
          rows: [
            {
              kind: 'tableRow',
              bbox: { x: 0, y: 0, w: 20, h: 10 },
              cells: [
                {
                  kind: 'tableCell',
                  bbox: { x: 100, y: 0, w: 20, h: 10 },
                  runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 200, h: 10 }, text: 'wide' }],
                },
              ],
            },
          ],
        },
      ],
    }
    // The run is drawn at 100..300, not 0..200.
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(0)
    expect(bounds.x + bounds.w).toBe(300)
  })

  it('applies the list-item offset to its children, which are item-relative', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'list',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: 40, y: 0, w: 10, h: 10 },
              children: [{ kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 100, h: 10 } }],
            },
          ],
        },
      ],
    }
    // The child is drawn at 40..140, not 0..100.
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(0)
    expect(bounds.x + bounds.w).toBe(140)
  })

  it('accumulates nested list-item offsets the way the renderer nests transforms', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'list',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: 40, y: 0, w: 10, h: 10 },
              children: [
                {
                  kind: 'list',
                  bbox: { x: 0, y: 0, w: 10, h: 10 },
                  ordered: false,
                  depth: 1,
                  items: [
                    {
                      kind: 'listItem',
                      bbox: { x: 80, y: 0, w: 10, h: 10 },
                      // Wider than the item box, so the assertion turns on the
                      // leaf's accumulated offset rather than the wrapper's.
                      children: [{ kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 60, h: 10 } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    // Nested <g transform> elements compose: 40 + 80 + 60 = 180.
    const bounds = sceneBounds(scene)
    expect(bounds.x + bounds.w).toBe(180)
  })

  // `sceneBounds` mirrors a rule that lives in the SVG backend: which node
  // kinds translate their subtree. Nothing links the two, so a third
  // translating renderer would silently make these bounds wrong again — the
  // containment property walks only top-level nodes and cannot see it. This
  // tripwire fails the moment that set changes, pointing at subtreeOffsetX.
  it('is kept in sync with the only two renderers that emit a transform', () => {
    const backendSource = (
      import.meta.glob('./svg/backend.ts', {
        query: '?raw',
        eager: true,
        import: 'default',
      }) as Record<string, string>
    )['./svg/backend.ts']

    // A renderer emits a transform by writing a `transform:` attribute onto
    // its VNode; ownership is the nearest preceding renderer declaration
    // (`function renderX(` or `const renderX = `). Comments discussing
    // transforms don't match the attribute spelling, so they cannot produce
    // false positives. The occurrence COUNT is pinned first and separately:
    // attribution by nearest-preceding-declaration could credit a new
    // emitter to a renderer already in the expected set (e.g. an arrow
    // function the declaration regex missed, defined right after one of the
    // two), and the count catches that case regardless of attribution.
    const occurrences = [...backendSource.matchAll(/transform: `translate\(/g)]
    expect(occurrences).toHaveLength(2)

    const declarationStarts = [
      ...backendSource.matchAll(/(?:function|const)\s+(render\w+)\s*[=(]/g),
    ].map((m) => ({ name: m[1], index: m.index ?? 0 }))
    const translating = occurrences.map(
      (m) => declarationStarts.filter((f) => f.index < (m.index ?? 0)).at(-1)?.name,
    )

    expect(new Set(translating)).toEqual(new Set(['renderListItem', 'renderTableCell']))
  })

  it('includes a top-level shape bbox', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 10, h: 10 } },
        { kind: 'shape', bbox: { x: 500, y: 500, w: 10, h: 10 } },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('applies the list-item offset to a nested shape, which is item-relative', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'list',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          ordered: false,
          depth: 0,
          items: [
            {
              kind: 'listItem',
              bbox: { x: 40, y: 0, w: 10, h: 10 },
              children: [{ kind: 'shape', bbox: { x: 0, y: 0, w: 100, h: 10 } }],
            },
          ],
        },
      ],
    }
    // The shape is drawn at 40..140, not 0..100.
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(0)
    expect(bounds.x + bounds.w).toBe(140)
  })

  it('does not overflow the stack on deep nesting (iterative walk)', () => {
    const DEPTH = 10000
    let node: Scene['nodes'][number] = { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 1, h: 1 } }
    for (let i = 0; i < DEPTH; i++) {
      node = { kind: 'group', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: [node] }
    }
    const scene: Scene = { nodes: [node] }
    expect(() => sceneBounds(scene)).not.toThrow()
  })
})
