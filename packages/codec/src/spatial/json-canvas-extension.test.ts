import { MAX_BENDS, spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { jsonCanvasDocumentSchema, jsonCanvasNodeSchema, xWhiteboardSchema } from './json-canvas.js'
import { parseSpatial } from './parse.js'

const baseGeometry = { id: 'n1', x: 0, y: 0, width: 100, height: 100 }

/**
 * How the WIRE schema treats the one extension key JSON Canvas 1.0 leaves room
 * for, at all three sites. These cases lived in the model's own tests until
 * [ADR-0037](../../../../docs/contributing/adr/0037-model-and-format.md) moved
 * the extension here: what they exercise is the FORMAT's behaviour — the
 * escape hatch that costs the extension rather than the document, a retired
 * key dropped like any foreign field, an embed refused on an edge — and none
 * of it is true of the model any more, which now carries `facets`
 * and `embed` as ordinary fields with no key to be unreadable.
 */

describe("a node's x-whiteboard", () => {
  it('accepts a node without x-whiteboard (strict JSON Canvas 1.0 doc unchanged)', () => {
    expect(
      jsonCanvasNodeSchema.safeParse({ ...baseGeometry, type: 'text', text: 'hi' }).success,
    ).toBe(true)
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
    const result = jsonCanvasNodeSchema.safeParse({
      ...baseGeometry,
      type: 'text',
      text: 'hi',
      embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
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

describe('canvas-level x-whiteboard', () => {
  const canvasWith = (extension: unknown) => ({
    nodes: [],
    edges: [],
    'x-whiteboard': extension,
  })

  it('carries a canvas-target facets bucket: routing and line jumps live there', () => {
    const parsed = jsonCanvasDocumentSchema.parse(
      canvasWith({ facets: { 'visual.edges/v0': { routing: 'orthogonal', lineJumps: 'arc' } } }),
    )
    expect(parsed['x-whiteboard']).toEqual({
      facets: { 'visual.edges/v0': { routing: 'orthogonal', lineJumps: 'arc' } },
    })
  })

  it('is absent-by-default, so a strict JSON Canvas document parses unchanged', () => {
    expect(jsonCanvasDocumentSchema.parse({ nodes: [], edges: [] })['x-whiteboard']).toBeUndefined()
  })

  // Retired without a compatibility read (0.0.x, no users): the key is
  // stripped like any foreign field, the facet beside it survives, and
  // nothing folds the old value into the facet.
  it('drops the retired edgeRouting preference and keeps the facets beside it', () => {
    const parsed = jsonCanvasDocumentSchema.parse(
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

  it('a malformed facet key costs the facets bucket only, never the sibling tags', () => {
    const parsed = jsonCanvasDocumentSchema.parse(
      canvasWith({ tags: ['kept'], facets: { 'not a key': {} } }),
    )
    expect(parsed['x-whiteboard']).toEqual({ tags: ['kept'] })
    expect(parsed.nodes).toEqual([])
  })

  // Same escape-hatch rule the node-level key follows: a payload this version
  // cannot read costs the extension, never the document.
  it('silently drops an unreadable extension rather than failing the canvas', () => {
    const parsed = jsonCanvasDocumentSchema.parse(canvasWith('not an object'))
    expect(parsed['x-whiteboard']).toBeUndefined()
    expect(parsed.nodes).toEqual([])
  })

  it('rejects nothing about the canvas itself when the extension is unreadable', () => {
    const parsed = jsonCanvasDocumentSchema.parse({
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
      edges: [],
      'x-whiteboard': 'not an object',
    })
    expect(parsed.nodes).toHaveLength(1)
  })
})

describe("an edge's x-whiteboard", () => {
  const edgeWith = (extension: unknown) =>
    jsonCanvasDocumentSchema.parse({
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

  // The model refuses an edge over `MAX_BENDS` and a reader that refuses it
  // drops the edge, so the wire schema holds the same line: an over-long list
  // is a malformed field, and costs the bends — the route is computed again —
  // never the edge and never a canvas the model then rejects.
  describe('bends', () => {
    const bends = (count: number) => Array.from({ length: count }, (_, i) => ({ x: i, y: -i }))

    it('keeps a list at the cap', () => {
      const edge = edgeWith({ bends: bends(MAX_BENDS) })
      expect(edge?.['x-whiteboard']?.bends).toHaveLength(MAX_BENDS)
    })

    it('drops a list over the cap, keeping the edge', () => {
      const edge = edgeWith({ bends: bends(MAX_BENDS + 1) })
      expect(edge).toEqual({ id: 'e1', fromNode: 'a', toNode: 'b', 'x-whiteboard': {} })
    })

    it('never lifts a canvas the model refuses', () => {
      const text = JSON.stringify({
        nodes: [
          { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
          { id: 'b', type: 'text', text: 'b', x: 50, y: 50, width: 10, height: 10 },
        ],
        edges: [
          { id: 'e1', fromNode: 'a', toNode: 'b', 'x-whiteboard': { bends: bends(MAX_BENDS + 1) } },
        ],
      })
      const parsed = parseSpatial(text)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(spatialCanvasSchema.safeParse(parsed.value).success).toBe(true)
    })
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

describe('a line whose facet bucket is malformed', () => {
  const lineWith = (facets: unknown) =>
    parseSpatial(
      JSON.stringify({
        nodes: [],
        edges: [],
        'x-whiteboard': {
          lines: [
            {
              id: 'l1',
              from: { kind: 'point', point: { x: 0, y: 0 } },
              to: { kind: 'point', point: { x: 5, y: 5 } },
              facets,
            },
          ],
        },
      }),
    )

  it('lifts without a facets key, as every other lifted element does', () => {
    const parsed = lineWith({ 'not a key': {} })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const line = parsed.value.lines?.[0] as object
    expect(Object.keys(line)).toEqual(['id', 'from', 'to'])
  })

  it('keeps a well-formed bucket', () => {
    const parsed = lineWith({ 'a.b/v0': 1 })
    expect(parsed.ok && parsed.value.lines?.[0]?.facets).toEqual({ 'a.b/v0': 1 })
  })
})
