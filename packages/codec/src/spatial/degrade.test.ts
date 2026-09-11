import { describe, expect, it } from 'vitest'
import { strictDegrade } from './degrade.js'
import { type JsonCanvasDocument, jsonCanvasDocumentSchema } from './json-canvas.js'

// The subject is the WIRE document, not the model. These fixtures were typed
// `SpatialCanvas` while the two were the same object; ADR-0035 slice 3 parted
// them (an endpoint is one object in the model and three flat keys here), and
// the annotation had to follow what the function actually takes.

const baseNode = { id: 'n1', x: 0, y: 0, width: 10, height: 10 }

describe('strictDegrade', () => {
  it('drops x-whiteboard from an embed-carrier node', () => {
    const canvas: JsonCanvasDocument = {
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': {
            kind: 'embed',
            documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
          },
        },
      ],
      edges: [],
    }

    const degraded = strictDegrade(canvas)
    expect(degraded.nodes[0]).not.toHaveProperty('x-whiteboard')
    expect(jsonCanvasDocumentSchema.safeParse(degraded).success).toBe(true)
  })

  it('drops x-whiteboard from a facets-carrier node', () => {
    const canvas: JsonCanvasDocument = {
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'ellipse' } } },
        },
      ],
      edges: [],
    }

    const degraded = strictDegrade(canvas)
    expect(degraded.nodes[0]).not.toHaveProperty('x-whiteboard')
    expect(jsonCanvasDocumentSchema.safeParse(degraded).success).toBe(true)
  })

  it('keeps file/subpath but drops x-whiteboard.documentId from an embed file-node', () => {
    const canvas: JsonCanvasDocument = {
      nodes: [
        {
          ...baseNode,
          type: 'file',
          file: 'other.md',
          subpath: '#heading',
          'x-whiteboard': { kind: 'embed', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        },
      ],
      edges: [],
    }

    const degraded = strictDegrade(canvas)
    const [node] = degraded.nodes
    expect(node).not.toHaveProperty('x-whiteboard')
    expect(node).toMatchObject({ file: 'other.md', subpath: '#heading' })
    expect(jsonCanvasDocumentSchema.safeParse(degraded).success).toBe(true)
  })

  it('leaves edges unchanged', () => {
    const canvas: JsonCanvasDocument = {
      nodes: [
        { ...baseNode, id: 'n1', type: 'text', text: 'a' },
        { ...baseNode, id: 'n2', type: 'text', text: 'b' },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    }

    const degraded = strictDegrade(canvas)
    expect(degraded.edges).toEqual(canvas.edges)
  })

  it('is idempotent: degrading twice equals degrading once', () => {
    const canvas: JsonCanvasDocument = {
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    }

    expect(strictDegrade(strictDegrade(canvas))).toEqual(strictDegrade(canvas))
  })
})

// The canvas-level key is a rendering preference, so strict JSON Canvas has
// no room for it either. `strictDegrade` rebuilding the canvas from nodes and
// edges alone already drops it — this pins that as the contract rather than
// leaving it to how the object happens to be constructed.
it('drops the canvas-level x-whiteboard as well', () => {
  const degraded = strictDegrade({
    nodes: [],
    edges: [],
    'x-whiteboard': { facets: { 'visual.edges/v0': { routing: 'orthogonal' } } },
  })

  expect(degraded).not.toHaveProperty('x-whiteboard')
})

// Same one rule at the third site: strict JSON Canvas 1.0 has no room for an
// edge's facets either, and an edge is rebuilt rather than passed through.
it("drops an edge's x-whiteboard facets bucket", () => {
  const degraded = strictDegrade({
    nodes: [],
    edges: [
      {
        id: 'e1',
        fromNode: 'a',
        toNode: 'b',
        label: 'kept',
        'x-whiteboard': { facets: { 'visual.edges/v0': { routing: 'curved' } } },
      },
    ],
  })

  expect(degraded.edges[0]).toEqual({ id: 'e1', fromNode: 'a', toNode: 'b', label: 'kept' })
})
