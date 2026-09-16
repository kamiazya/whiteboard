import { describe, expect, it } from 'vitest'
import {
  canvasColorSchema,
  canvasCommentSchema,
  canvasEdgeSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
} from './spatial.js'

const baseGeometry = { id: 'n1', x: 0, y: 0, width: 100, height: 100 }

/** A node showing markdown, for the cases that are about something else. */
const text = (content: string) => ({ resource: { mimeType: 'text/markdown', content } })

describe('canvasColorSchema', () => {
  it('accepts preset colors 1-6', () => {
    for (const preset of ['1', '2', '3', '4', '5', '6']) {
      expect(canvasColorSchema.safeParse(preset).success).toBe(true)
    }
  })

  it('accepts a 6-digit hex color', () => {
    expect(canvasColorSchema.safeParse('#a1B2c3').success).toBe(true)
  })

  it('rejects preset 7, a 3-digit hex, and a named color', () => {
    expect(canvasColorSchema.safeParse('7').success).toBe(false)
    expect(canvasColorSchema.safeParse('#abc').success).toBe(false)
    expect(canvasColorSchema.safeParse('red').success).toBe(false)
  })
})

/**
 * ADR-0038 decision 3: a node is a box that may SHOW a resource, and the
 * KIND is derived from that resource rather than stored beside it. The
 * `text | file | link | group` union these describes used to be one per arm
 * of is gone, so the claims that survive are about the RESOURCE, and two
 * that did not survive are named where they were.
 */
describe('spatialNodeSchema: what a node shows', () => {
  it('accepts a node showing markdown it carries itself', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, ...text('hello') }).success).toBe(true)
  })

  it('accepts a node pointing at a document, with a #-prefixed fragment', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        resource: { mimeType: 'application/octet-stream', location: 'a.md', subpath: '#heading' },
      }).success,
    ).toBe(true)
  })

  it('rejects a fragment not starting with #', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        resource: { mimeType: 'application/octet-stream', location: 'a.md', subpath: 'heading' },
      }).success,
    ).toBe(false)
  })

  it('accepts a node pointing at an address', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        resource: { mimeType: 'text/uri-list', location: 'https://example.com' },
      }).success,
    ).toBe(true)
  })

  /**
   * The `link` arm carried `url: z.string().url()`. Dissolving the union
   * would have dropped that check with the arm, so it moved onto the
   * resource: a `text/uri-list` location is an address and is still checked
   * as one, while a file's location stays a plain path.
   */
  it('rejects an address that is not a URL', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        resource: { mimeType: 'text/uri-list', location: 'not a url' },
      }).success,
    ).toBe(false)
  })

  /**
   * The node-kind union could not express this at all: an unknown arm failed
   * to parse and `readSpatialCanvas` drops what fails, so such a node VANISHED.
   * OCIF conformance requires keeping it, so it is schema-valid and every
   * reader answers for it — `nodeKind` says `undefined`, the layout degrades
   * it to chrome, the index contributes nothing for it.
   */
  it('accepts a resource whose media type nothing in this build claims', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        resource: { mimeType: 'application/x-nothing-claims-this' },
      }).success,
    ).toBe(true)
  })

  it('rejects a resource with no media type', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, resource: { content: 'hi' } }).success,
    ).toBe(false)
  })

  /**
   * Two claims retired with the union rather than moved: "a text node missing
   * text" and "a file node missing file" are both A NODE THAT SHOWS NOTHING,
   * which is precisely the frame. There is nothing left to reject.
   */
  it('accepts a node that shows nothing, which is the frame', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry }).success).toBe(true)
  })

  it("accepts a frame's own fields", () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        label: 'Section',
        background: 'bg.png',
        backgroundStyle: 'cover',
      }).success,
    ).toBe(true)
  })

  it('rejects an invalid backgroundStyle', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, backgroundStyle: 'stretch' }).success,
    ).toBe(false)
  })

  it('rejects the stored discriminant the union used to carry', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, type: 'text', text: 'hi' }).success).toBe(
      false,
    )
  })
})

describe('spatialNodeSchema: geometry', () => {
  // ADR-0037 slice 4: geometry is a real number here, because ink is
  // sub-pixel. JSON Canvas 1.0's integer pixels are the PROJECTION's rounding.
  it('accepts a sub-pixel coordinate and keeps it', () => {
    const parsed = spatialNodeSchema.safeParse({ ...baseGeometry, x: 1.5, ...text('hi') })
    expect(parsed.success && parsed.data.x).toBe(1.5)
  })

  it('rejects geometry JSON cannot carry', () => {
    for (const x of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(spatialNodeSchema.safeParse({ ...baseGeometry, x, ...text('hi') }).success).toBe(false)
    }
  })

  it('rejects negative width and height', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, width: -1, ...text('hi') }).success).toBe(
      false,
    )
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, height: -1, ...text('hi') }).success,
    ).toBe(false)
  })

  it('accepts zero width/height (degenerate boxes) and negative x/y', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        x: -50,
        y: -50,
        width: 0,
        height: 0,
        ...text('hi'),
      }).success,
    ).toBe(true)
  })
})

describe('canvasEdgeSchema', () => {
  it('accepts a minimal edge', () => {
    expect(
      canvasEdgeSchema.safeParse({
        id: 'e1',
        from: { node: 'n1' },
        to: { node: 'n2' },
      }).success,
    ).toBe(true)
  })

  it('accepts a full edge', () => {
    const result = canvasEdgeSchema.safeParse({
      id: 'e1',
      from: { node: 'n1', side: 'top', end: 'none' as const },
      to: { node: 'n2', side: 'bottom', end: 'arrow' as const },
      color: '1',
      label: 'connects',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid side and end', () => {
    expect(
      canvasEdgeSchema.safeParse({
        id: 'e1',
        from: { node: 'n1', side: 'north' },
        to: { node: 'n2' },
      }).success,
    ).toBe(false)
    expect(
      canvasEdgeSchema.safeParse({
        id: 'e1',
        from: { node: 'n1' },
        to: { node: 'n2', end: 'diamond' },
      }).success,
    ).toBe(false)
  })

  it('rejects a missing fromNode or toNode', () => {
    expect(canvasEdgeSchema.safeParse({ id: 'e1', to: { node: 'n2' } }).success).toBe(false)
    expect(canvasEdgeSchema.safeParse({ id: 'e1', from: { node: 'n1' } }).success).toBe(false)
  })
})

describe('spatialCanvasSchema', () => {
  const node1 = { ...baseGeometry, id: 'n1', ...text('a') }
  const node2 = { ...baseGeometry, id: 'n2', ...text('b') }

  it('accepts distinct node and edge ids', () => {
    const result = spatialCanvasSchema.safeParse({
      nodes: [node1, node2],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate node ids', () => {
    const result = spatialCanvasSchema.safeParse({
      nodes: [node1, { ...node2, id: 'n1' }],
      edges: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects duplicate edge ids', () => {
    const result = spatialCanvasSchema.safeParse({
      nodes: [node1, node2],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
        {
          id: 'e1',
          from: { node: 'n2' },
          to: { node: 'n1' },
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts an empty document with both arrays omitted, per JSON Canvas 1.0 optionality', () => {
    const result = spatialCanvasSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ nodes: [], edges: [] })
    }
  })

  it('accepts a document with only nodes present', () => {
    const result = spatialCanvasSchema.safeParse({ nodes: [node1] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.edges).toEqual([])
    }
  })

  it('accepts a document with only edges present (edges referencing nothing)', () => {
    const result = spatialCanvasSchema.safeParse({ edges: [] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.nodes).toEqual([])
    }
  })

  it('rejects an edge whose fromNode or toNode references a nonexistent node id', () => {
    const missingFrom = spatialCanvasSchema.safeParse({
      nodes: [node2],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
    })
    expect(missingFrom.success).toBe(false)

    const missingTo = spatialCanvasSchema.safeParse({
      nodes: [node1],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
    })
    expect(missingTo.success).toBe(false)
  })
})

// Route SHAPE is a canvas-wide preference, not per-node decoration: an edge
// routed one way and its neighbour another reads as a bug, not a choice.
// interpret it still holds a complete document.
describe('canvasCommentSchema', () => {
  const minimal = { id: 'c1', x: 100, y: -40, text: 'this arrow points the wrong way' }

  it('accepts the minimal shape: id + integer anchor + non-empty text', () => {
    expect(canvasCommentSchema.safeParse(minimal).success).toBe(true)
  })

  it('accepts the full shape: OKF actor author, OKF timestamp, target node, resolved', () => {
    const parsed = canvasCommentSchema.safeParse({
      ...minimal,
      author: 'human:yuuki',
      createdAt: '2026-09-01T10:00:00+09:00',
      targetNodeId: 'n1',
      resolved: true,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects empty text — a comment with nothing to say is a caller bug', () => {
    expect(canvasCommentSchema.safeParse({ ...minimal, text: '' }).success).toBe(false)
  })

  it('rejects a non-integer anchor, matching JSON Canvas geometry', () => {
    expect(canvasCommentSchema.safeParse({ ...minimal, x: 1.5 }).success).toBe(false)
  })

  it('rejects a blank author and a timestamp without an explicit offset', () => {
    expect(canvasCommentSchema.safeParse({ ...minimal, author: '  ' }).success).toBe(false)
    expect(
      canvasCommentSchema.safeParse({ ...minimal, createdAt: '2026-09-01T10:00:00' }).success,
    ).toBe(false)
  })

  it('rejects a comment naming both a node and an edge — the anchor it becomes names one', () => {
    // `threadFromCanvasComment` carries both targets onto one spatial
    // anchor, and `annotationAnchorSchema` refuses an anchor naming two
    // objects — so a comment shaped this way was accepted here, written,
    // and then silently dropped by every reader of the thread it became.
    expect(canvasCommentSchema.safeParse({ ...minimal, targetNodeId: 'n1' }).success).toBe(true)
    expect(canvasCommentSchema.safeParse({ ...minimal, targetEdgeId: 'e1' }).success).toBe(true)
    const both = canvasCommentSchema.safeParse({
      ...minimal,
      targetNodeId: 'n1',
      targetEdgeId: 'e1',
    })
    expect(both.success).toBe(false)
  })
})
