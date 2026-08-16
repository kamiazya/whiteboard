import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
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
      'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
    },
  ],
  edges: [],
}

describe('serializeSpatial', () => {
  it('extended mode stringifies the canvas as-is, keeping x-whiteboard', () => {
    const text = serializeSpatial(canvasWithExtension, 'extended')
    expect(JSON.parse(text)).toEqual(canvasWithExtension)
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

it('extended mode keeps the canvas-level x-whiteboard through a round trip', () => {
  const canvas: SpatialCanvas = {
    nodes: [],
    edges: [],
    'x-whiteboard': { edgeRouting: { style: 'curved' } },
  }
  const result = parseSpatial(serializeSpatial(canvas, 'extended'))

  expect(result.ok).toBe(true)
  expect(result.ok && result.value['x-whiteboard']).toEqual({ edgeRouting: { style: 'curved' } })
})
