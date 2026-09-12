// ADR-0036 decision 2: a RELATION and a DRAWN LINE are two things.
//
// Red first. An edge whose end is a bare point is the conflation the split
// removes — it was reached by widening the relation until it could hold a
// drawing, and OCIF is where that stopped projecting: `@ocif/edge`'s ends must
// be node ids, so a free end is an `@ocif/arrow`, which is a shape.
import { describe, expect, it } from 'vitest'
import { canvasEdgeSchema, canvasLineSchema, spatialCanvasSchema } from './spatial.js'

describe('an edge is a relation', () => {
  it('runs between two nodes', () => {
    const parsed = canvasEdgeSchema.safeParse({
      id: 'e1',
      from: { node: 'a', side: 'right' },
      to: { node: 'b', end: 'arrow' },
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses an end at a bare point, because that is a drawing', () => {
    const parsed = canvasEdgeSchema.safeParse({
      id: 'e1',
      from: { node: 'a' },
      to: { point: { x: 1, y: 2 } },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('a line is ink', () => {
  it('may end nowhere', () => {
    const parsed = canvasLineSchema.safeParse({
      id: 'l1',
      from: { kind: 'point', point: { x: 0, y: 0 } },
      to: { kind: 'point', point: { x: 10, y: 10 } },
    })
    expect(parsed.success).toBe(true)
  })

  it('may still attach to a node at one end, which is what a connect gesture released in space makes', () => {
    const parsed = canvasLineSchema.safeParse({
      id: 'l1',
      from: { kind: 'node', node: 'a', side: 'right' },
      to: { kind: 'point', point: { x: 10, y: 10 }, end: 'arrow' },
    })
    expect(parsed.success).toBe(true)
  })

  it('may join two nodes without claiming they are related', () => {
    // The expressiveness the split buys and the old shape could not state:
    // decorative ink between two boxes is not an assertion that they are
    // connected. It is also what freehand will need a home for.
    const parsed = canvasLineSchema.safeParse({
      id: 'l1',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'node', node: 'b' },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('a canvas holds both, and neither by accident', () => {
  it('leaves lines absent rather than empty, which says the same thing', () => {
    // Optional rather than `.default([])`, measured: the default makes the
    // field required on the output type, and 925 canvas literals across 295
    // files would each have gained a `lines: []` that says nothing. Readers
    // spell `canvas.lines ?? []`, the way they already do for `comments`.
    const parsed = spatialCanvasSchema.parse({ nodes: [], edges: [] })
    expect(parsed.lines).toBeUndefined()
    expect(spatialCanvasSchema.parse({ nodes: [], edges: [], lines: [] }).lines).toEqual([])
  })

  it('refuses a line id that collides with an edge id', () => {
    // Ids are unique across the canvas, not per collection: a comment anchors
    // to `targetEdgeId`, and a proposal to an element id, so two elements
    // answering to one id makes an anchor ambiguous rather than merely untidy.
    const parsed = spatialCanvasSchema.safeParse({
      nodes: [],
      edges: [{ id: 'x', from: { node: 'a' }, to: { node: 'b' } }],
      lines: [
        {
          id: 'x',
          from: { kind: 'point', point: { x: 0, y: 0 } },
          to: { kind: 'point', point: { x: 1, y: 1 } },
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})
