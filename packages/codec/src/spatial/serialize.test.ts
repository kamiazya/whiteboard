import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { parseSpatial } from './parse.js'
import { serializeSpatial } from './serialize.js'

const baseNode = { id: 'n1', x: 0, y: 0, width: 10, height: 10 } as const

const canvasWithExtension: SpatialCanvas = {
  nodes: [
    {
      ...baseNode,
      type: 'text',
      text: '',
      embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
    },
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

  it('strict mode re-validates the degraded document and throws if it is not schema-valid', async () => {
    vi.resetModules()
    vi.doMock('./degrade.js', () => ({
      // Simulates a strictDegrade bug: leaves the document invalid (missing
      // required `type`) instead of a schema-valid strict document.
      strictDegrade: (canvas: SpatialCanvas) => ({
        ...canvas,
        nodes: canvas.nodes.map(({ type: _type, ...rest }) => rest),
      }),
    }))

    const { serializeSpatial: serializeSpatialWithBrokenDegrade } = await import('./serialize.js')

    expect(() => serializeSpatialWithBrokenDegrade(canvasWithExtension, 'strict')).toThrow()

    vi.doUnmock('./degrade.js')
    vi.resetModules()
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
      {
        id: 'n1',
        type: 'text',
        text: 'shaped',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      },
    ],
    edges: [],
  }
  const result = parseSpatial(serializeSpatial(canvas, 'extended'))
  expect(result.ok).toBe(true)
  expect(result.ok && result.value.nodes[0]?.facets).toEqual({
    'visual.shape/v0': { kind: 'hexagon' },
  })
})
