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

    const translating = [
      ...backendSource.matchAll(/function (render\w+)\([^)]*\)[^{]*\{([^}]*)\}/g),
    ]
      .filter(([, , body]) => body.includes('transform="translate('))
      .map(([, name]) => name)

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
