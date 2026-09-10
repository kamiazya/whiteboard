import { describe, expect, it } from 'vitest'
import {
  canvasColorSchema,
  canvasCommentSchema,
  canvasEdgeSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
  xWhiteboardSchema,
} from './spatial.js'

const baseGeometry = { id: 'n1', x: 0, y: 0, width: 100, height: 100 }

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

describe('spatialNodeSchema (text)', () => {
  it('accepts a minimal text node', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, type: 'text', text: 'hello' }).success,
    ).toBe(true)
  })

  it('rejects a text node missing text', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, type: 'text' }).success).toBe(false)
  })

  it('rejects non-integer geometry', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, x: 1.5, type: 'text', text: 'hi' }).success,
    ).toBe(false)
  })

  it('rejects negative width and height', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, width: -1, type: 'text', text: 'hi' }).success,
    ).toBe(false)
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, height: -1, type: 'text', text: 'hi' })
        .success,
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
        type: 'text',
        text: 'hi',
      }).success,
    ).toBe(true)
  })
})

describe('spatialNodeSchema (file)', () => {
  it('accepts a file node with a #-prefixed subpath', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        type: 'file',
        file: 'a.md',
        subpath: '#heading',
      }).success,
    ).toBe(true)
  })

  it('accepts a file node without subpath', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, type: 'file', file: 'a.md' }).success,
    ).toBe(true)
  })

  it('rejects a subpath not starting with #', () => {
    expect(
      spatialNodeSchema.safeParse({
        ...baseGeometry,
        type: 'file',
        file: 'a.md',
        subpath: 'heading',
      }).success,
    ).toBe(false)
  })

  it('rejects a file node missing file', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, type: 'file' }).success).toBe(false)
  })
})

describe('spatialNodeSchema (link)', () => {
  it('accepts a link node with a url', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, type: 'link', url: 'https://example.com' })
        .success,
    ).toBe(true)
  })

  it('rejects an invalid url', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, type: 'link', url: 'not a url' }).success,
    ).toBe(false)
  })
})

describe('spatialNodeSchema (group)', () => {
  it('accepts a minimal group node', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, type: 'group' }).success).toBe(true)
  })

  it('accepts a full group node', () => {
    const result = spatialNodeSchema.safeParse({
      ...baseGeometry,
      type: 'group',
      label: 'Section',
      background: 'bg.png',
      backgroundStyle: 'cover',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid backgroundStyle', () => {
    expect(
      spatialNodeSchema.safeParse({ ...baseGeometry, type: 'group', backgroundStyle: 'stretch' })
        .success,
    ).toBe(false)
  })
})

describe('x-whiteboard extension', () => {
  it('accepts a node without x-whiteboard (strict JSON Canvas 1.0 doc unchanged)', () => {
    expect(spatialNodeSchema.safeParse({ ...baseGeometry, type: 'text', text: 'hi' }).success).toBe(
      true,
    )
  })

  it('accepts an embed payload with a valid documentId and rejects a malformed one', () => {
    expect(
      xWhiteboardSchema.safeParse({ kind: 'embed', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
        .success,
    ).toBe(true)
    expect(xWhiteboardSchema.safeParse({ kind: 'embed', documentId: 'not-a-ulid' }).success).toBe(
      false,
    )
  })

  it('attaches to a node under the x-whiteboard key', () => {
    const result = spatialNodeSchema.safeParse({
      ...baseGeometry,
      type: 'text',
      text: 'hi',
      'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
    })
    expect(result.success).toBe(true)
  })

  it('carries node-target facets without an embed (ADR-0013 decision 5)', () => {
    const result = xWhiteboardSchema.safeParse({
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.facets).toEqual({ 'visual.shape/v0': { kind: 'hexagon' } })
    }
  })

  it('carries facets beside an embed', () => {
    const result = xWhiteboardSchema.safeParse({
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      facets: { 'visual.shape/v0': { kind: 'ellipse' } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.facets).toEqual({ 'visual.shape/v0': { kind: 'ellipse' } })
    }
  })

  it('a malformed node facet key costs the facets bucket only, never the embed', () => {
    const result = xWhiteboardSchema.safeParse({
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      facets: { 'not a key': {} },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' })
    }
  })
})

describe('canvasEdgeSchema', () => {
  it('accepts a minimal edge', () => {
    expect(canvasEdgeSchema.safeParse({ id: 'e1', fromNode: 'n1', toNode: 'n2' }).success).toBe(
      true,
    )
  })

  it('accepts a full edge', () => {
    const result = canvasEdgeSchema.safeParse({
      id: 'e1',
      fromNode: 'n1',
      toNode: 'n2',
      fromSide: 'top',
      toSide: 'bottom',
      fromEnd: 'none',
      toEnd: 'arrow',
      color: '1',
      label: 'connects',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid side and end', () => {
    expect(
      canvasEdgeSchema.safeParse({ id: 'e1', fromNode: 'n1', toNode: 'n2', fromSide: 'north' })
        .success,
    ).toBe(false)
    expect(
      canvasEdgeSchema.safeParse({ id: 'e1', fromNode: 'n1', toNode: 'n2', toEnd: 'diamond' })
        .success,
    ).toBe(false)
  })

  it('rejects a missing fromNode or toNode', () => {
    expect(canvasEdgeSchema.safeParse({ id: 'e1', toNode: 'n2' }).success).toBe(false)
    expect(canvasEdgeSchema.safeParse({ id: 'e1', fromNode: 'n1' }).success).toBe(false)
  })
})

describe('spatialCanvasSchema', () => {
  const node1 = { ...baseGeometry, id: 'n1', type: 'text', text: 'a' }
  const node2 = { ...baseGeometry, id: 'n2', type: 'text', text: 'b' }

  it('accepts distinct node and edge ids', () => {
    const result = spatialCanvasSchema.safeParse({
      nodes: [node1, node2],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
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
        { id: 'e1', fromNode: 'n1', toNode: 'n2' },
        { id: 'e1', fromNode: 'n2', toNode: 'n1' },
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
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    expect(missingFrom.success).toBe(false)

    const missingTo = spatialCanvasSchema.safeParse({
      nodes: [node1],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    expect(missingTo.success).toBe(false)
  })
})

// Route SHAPE is a canvas-wide preference, not per-node decoration: an edge
// routed one way and its neighbour another reads as a bug, not a choice.
describe('canvas-level x-whiteboard', () => {
  const canvasWith = (extension: unknown) => ({
    nodes: [],
    edges: [],
    'x-whiteboard': extension,
  })

  it('carries a canvas-target facets bucket: routing and line jumps live there', () => {
    const parsed = spatialCanvasSchema.parse(
      canvasWith({ facets: { 'visual.edges/v0': { routing: 'orthogonal', lineJumps: 'arc' } } }),
    )
    expect(parsed['x-whiteboard']).toEqual({
      facets: { 'visual.edges/v0': { routing: 'orthogonal', lineJumps: 'arc' } },
    })
  })

  it('is absent-by-default, so a strict JSON Canvas document parses unchanged', () => {
    expect(spatialCanvasSchema.parse({ nodes: [], edges: [] })['x-whiteboard']).toBeUndefined()
  })

  // Retired without a compatibility read (0.0.x, no users): the key is
  // stripped like any foreign field, the facet beside it survives, and
  // nothing folds the old value into the facet.
  it('drops the retired edgeRouting preference and keeps the facets beside it', () => {
    const parsed = spatialCanvasSchema.parse(
      canvasWith({
        edgeRouting: { style: 'orthogonal' },
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      }),
    )
    expect(parsed['x-whiteboard']).toEqual({
      facets: { 'visual.edges/v0': { routing: 'curved' } },
    })
    expect(parsed['x-whiteboard']).not.toHaveProperty('edgeRouting')
  })

  it('a malformed facet key costs the facets bucket only, never the sibling comments', () => {
    const parsed = spatialCanvasSchema.parse(
      canvasWith({
        comments: [{ id: 'c1', x: 1, y: 2, text: 'kept' }],
        facets: { 'not a key': {} },
      }),
    )
    expect(parsed['x-whiteboard']).toEqual({ comments: [{ id: 'c1', x: 1, y: 2, text: 'kept' }] })
    expect(parsed.nodes).toEqual([])
  })

  // Same escape-hatch rule the node-level key follows: a payload this version
  // cannot read costs the extension, never the document.
  it('silently drops an unreadable extension rather than failing the canvas', () => {
    const parsed = spatialCanvasSchema.parse(canvasWith('not an object'))
    expect(parsed['x-whiteboard']).toBeUndefined()
    expect(parsed.nodes).toEqual([])
  })

  it('rejects nothing about the canvas itself when the extension is unreadable', () => {
    const parsed = spatialCanvasSchema.parse({
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
      edges: [],
      'x-whiteboard': 'not an object',
    })
    expect(parsed.nodes).toHaveLength(1)
  })
})

// The annotation layer (ADR-0024): a comment is pinned AT an anchor point but
// is not content — it must never cost the canvas, and a reader that cannot
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
})

describe('canvas comments on the canvas-level extension', () => {
  const comment = { id: 'c1', x: 10, y: 20, text: 'shrink this' }

  it('carries comments beside the canvas facets', () => {
    const parsed = spatialCanvasSchema.parse({
      nodes: [],
      edges: [],
      'x-whiteboard': {
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
        comments: [comment],
      },
    })
    expect(parsed['x-whiteboard']).toEqual({
      facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      comments: [comment],
    })
  })

  it('a malformed comment costs the comments bucket only, never the sibling facets', () => {
    const parsed = spatialCanvasSchema.parse({
      nodes: [],
      edges: [],
      'x-whiteboard': {
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
        comments: [{ id: 'c1', x: 10, y: 20, text: '' }],
      },
    })
    expect(parsed['x-whiteboard']).toEqual({
      facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
    })
  })

  // Deliberately UNLIKE an edge's endpoints: a comment may outlive the node it
  // was left on (or arrive about one a concurrent peer deleted), and a
  // renderer falls back to the anchor point. Rejecting would let the
  // annotation layer make the document unreadable.
  it('accepts a targetNodeId that names no existing node', () => {
    const parsed = spatialCanvasSchema.safeParse({
      nodes: [],
      edges: [],
      'x-whiteboard': { comments: [{ ...comment, targetNodeId: 'gone' }] },
    })
    expect(parsed.success).toBe(true)
  })
})

describe("an edge's x-whiteboard", () => {
  const edgeWith = (extension: unknown) =>
    spatialCanvasSchema.parse({
      nodes: [
        { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b', type: 'text', text: 'b', x: 50, y: 50, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', 'x-whiteboard': extension }],
    }).edges[0]

  it('carries a facets bucket, and nothing else', () => {
    expect(edgeWith({ facets: { 'visual.edges/v0': { routing: 'curved' } } })).toEqual({
      id: 'e1',
      fromNode: 'a',
      toNode: 'b',
      'x-whiteboard': { facets: { 'visual.edges/v0': { routing: 'curved' } } },
    })
  })

  // An edge has no content JSON Canvas cannot express, so unlike a node's key
  // this one never carries an embed — a payload shaped like one is not an
  // edge extension and costs the extension, never the edge.
  it('refuses an embed, dropping the extension and keeping the edge', () => {
    const edge = edgeWith({ kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V9' })
    expect(edge).toEqual({ id: 'e1', fromNode: 'a', toNode: 'b' })
  })

  it('a malformed facet key costs the bucket, never the edge', () => {
    expect(edgeWith({ facets: { 'not a key': {} } })).toEqual({
      id: 'e1',
      fromNode: 'a',
      toNode: 'b',
      'x-whiteboard': {},
    })
  })
})
