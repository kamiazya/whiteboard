import { describe, expect, it } from 'vitest'
import {
  canvasColorSchema,
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

  it('accepts zero width/height (degenerate freehand bounding boxes) and negative x/y', () => {
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

  it('accepts a freehand payload with 2+ points', () => {
    const result = xWhiteboardSchema.safeParse({
      kind: 'freehand',
      points: [
        [0, 0],
        [1, 1],
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a freehand payload with a single point', () => {
    expect(xWhiteboardSchema.safeParse({ kind: 'freehand', points: [[0, 0]] }).success).toBe(false)
  })

  it('rejects freehand pressures whose length does not match points', () => {
    const result = xWhiteboardSchema.safeParse({
      kind: 'freehand',
      points: [
        [0, 0],
        [1, 1],
      ],
      pressures: [0.5],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a pressure outside [0, 1]', () => {
    const result = xWhiteboardSchema.safeParse({
      kind: 'freehand',
      points: [
        [0, 0],
        [1, 1],
      ],
      pressures: [0.5, 1.2],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a shape payload with a valid shape name and rejects an unknown one', () => {
    expect(xWhiteboardSchema.safeParse({ kind: 'shape', shape: 'ellipse' }).success).toBe(true)
    expect(xWhiteboardSchema.safeParse({ kind: 'shape', shape: 'star' }).success).toBe(false)
  })

  it('accepts an embed payload with a valid canvasId and rejects a malformed one', () => {
    expect(
      xWhiteboardSchema.safeParse({ kind: 'embed', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
        .success,
    ).toBe(true)
    expect(xWhiteboardSchema.safeParse({ kind: 'embed', canvasId: 'not-a-ulid' }).success).toBe(
      false,
    )
  })

  it('attaches to a node under the x-whiteboard key', () => {
    const result = spatialNodeSchema.safeParse({
      ...baseGeometry,
      type: 'text',
      text: 'hi',
      'x-whiteboard': { kind: 'shape', shape: 'rectangle' },
    })
    expect(result.success).toBe(true)
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
