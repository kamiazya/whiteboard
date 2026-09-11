import { describe, expect, it } from 'vitest'
import {
  canvasColorSchema,
  canvasCommentSchema,
  canvasEdgeSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
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

  // ADR-0033 slice 4: geometry is a real number here, because ink is
  // sub-pixel. JSON Canvas 1.0's integer pixels are the PROJECTION's rounding.
  it('accepts a sub-pixel coordinate and keeps it', () => {
    const parsed = spatialNodeSchema.safeParse({
      ...baseGeometry,
      x: 1.5,
      type: 'text',
      text: 'hi',
    })
    expect(parsed.success && parsed.data.x).toBe(1.5)
  })

  it('rejects geometry JSON cannot carry', () => {
    for (const x of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        spatialNodeSchema.safeParse({ ...baseGeometry, x, type: 'text', text: 'hi' }).success,
      ).toBe(false)
    }
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
