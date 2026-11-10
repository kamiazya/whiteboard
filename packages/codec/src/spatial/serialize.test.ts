import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { parseSpatial, serializeSpatial } from './spatial-core.js'

const baseNode = { id: 'n1', x: 0, y: 0, width: 10, height: 10 } as const

const canvasWithExtension: SpatialCanvas = {
  nodes: [
    textNode({
      ...baseNode,
      text: '',
      embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
    }),
  ],
  edges: [],
}

describe('serializeSpatial', () => {
  it('extended mode writes the model through the projection, so the embed lands on x-whiteboard', () => {
    // Not "as-is" any more: the model carries `embed` as a field of its own
    // and the FORMAT carries it as the extension's embed arm. What extended
    // mode promises is that nothing is lost across that move, which is the
    // round-trip below rather than an equality with the input.
    const text = serializeSpatial(canvasWithExtension, 'extended')
    expect(JSON.parse(text)).toEqual({
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    })
    const back = parseSpatial(text)
    expect(back.ok && back.value).toEqual(canvasWithExtension)
  })

  it('strict mode drops x-whiteboard and produces a schema-valid JSON Canvas 1.0 document', () => {
    const text = serializeSpatial(canvasWithExtension, 'strict')
    const parsed = JSON.parse(text)

    expect(parsed.nodes[0]).not.toHaveProperty('x-whiteboard')
    expect(parsed).toEqual({
      nodes: [{ ...baseNode, type: 'text', text: '' }],
      edges: [],
    })
  })
})

it('extended mode keeps the canvas-level facets bucket through a round trip', () => {
  const canvas: SpatialCanvas = {
    nodes: [],
    edges: [],
    facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
  }
  const result = parseSpatial(serializeSpatial(canvas, 'extended'))

  expect(result.ok).toBe(true)
  expect(result.ok && result.value.facets).toEqual({
    'visual.edges/v0': { routing: 'orthogonal' },
  })
})

// The pre-facet `edgeRouting` preference is retired with NO compatibility
// read (0.0.x, no users): a file still carrying it parses, keeps its facets,
// and loses that one key — never re-emitted, never folded into the facet.
it('drops the retired canvas-level edgeRouting key on parse and never re-emits it', () => {
  const result = parseSpatial(
    JSON.stringify({
      nodes: [],
      edges: [],
      'x-whiteboard': {
        edgeRouting: { style: 'curved' },
        facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
      },
    }),
  )

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.facets).toEqual({ 'visual.edges/v0': { routing: 'orthogonal' } })
  expect(serializeSpatial(result.value, 'extended')).not.toContain('edgeRouting')
})

it('strict mode drops the facets bucket with the rest of x-whiteboard (one uniform rule)', () => {
  const canvas: SpatialCanvas = {
    nodes: [],
    edges: [],
    facets: { 'visual.edges/v0': { routing: 'curved' } },
  }
  const text = serializeSpatial(canvas, 'strict')
  expect(text).not.toContain('x-whiteboard')
  expect(text).not.toContain('facets')
})

it('extended mode keeps node-level facets (with and without an embed) through a round trip', () => {
  const canvas: SpatialCanvas = {
    nodes: [
      textNode({
        id: 'n1',
        text: 'shaped',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      }),
    ],
    edges: [],
  }
  const result = parseSpatial(serializeSpatial(canvas, 'extended'))
  expect(result.ok).toBe(true)
  expect(result.ok && result.value.nodes[0]?.facets).toEqual({
    'visual.shape/v0': { kind: 'hexagon' },
  })
})

// Strict mode applies ONE uniform rule: the whole `x-whiteboard` key goes, at
// each of its three sites, and nothing else is touched.
describe('strict mode degradation, through the core', () => {
  const embed = { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' as const }
  const strictWire = (canvas: SpatialCanvas) => JSON.parse(serializeSpatial(canvas, 'strict'))

  it('drops the extension from an embed-carrier node and from a facets-carrier node', () => {
    const wire = strictWire({
      nodes: [
        textNode({ ...baseNode, id: 'a', text: '', embed }),
        textNode({
          ...baseNode,
          id: 'b',
          text: '',
          facets: { 'visual.shape/v0': { kind: 'ellipse' } },
        }),
      ],
      edges: [],
    })
    expect(wire.nodes).toEqual([
      { ...baseNode, id: 'a', type: 'text', text: '' },
      { ...baseNode, id: 'b', type: 'text', text: '' },
    ])
  })

  it('keeps file and subpath but drops the embed from an embed file node', () => {
    const wire = strictWire({
      nodes: [
        {
          ...baseNode,
          id: 'f',
          embed,
          resource: { mimeType: 'text/markdown', location: 'other.md', subpath: '#heading' },
        } as SpatialCanvas['nodes'][number],
      ],
      edges: [],
    })
    expect(wire.nodes[0]).toMatchObject({ type: 'file', file: 'other.md', subpath: '#heading' })
    expect(wire.nodes[0]).not.toHaveProperty('x-whiteboard')
  })

  it("keeps an edge's own fields and drops its facets bucket", () => {
    const wire = strictWire({
      nodes: [
        textNode({ ...baseNode, id: 'a', text: 'a' }),
        textNode({ ...baseNode, id: 'b', text: 'b' }),
      ],
      edges: [
        {
          id: 'e1',
          from: { node: 'a' },
          to: { node: 'b' },
          label: 'kept',
          facets: { 'visual.edges/v0': { routing: 'curved' } },
        },
      ],
    })
    expect(wire.edges).toEqual([{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'kept' }])
  })

  it('is idempotent: writing what strict mode wrote, strictly, changes nothing', () => {
    const first = serializeSpatial(
      { nodes: [textNode({ ...baseNode, text: '', embed })], edges: [], facets: { 'a.b/v0': 1 } },
      'strict',
    )
    const read = parseSpatial(first)
    if (!read.ok) throw new Error(read.error.message)
    expect(serializeSpatial(read.value, 'strict')).toBe(first)
  })
})
