import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { buildViewerScene } from './spatial-scene.js'

const fakeMeasure: MeasureText = (text) => ({
  advanceWidth: text.length * 8,
  ascent: 12,
  descent: 4,
  lineGap: 0,
})

describe('buildViewerScene', () => {
  it('renders an empty canvas as an empty scene without throwing', () => {
    const canvas: SpatialCanvas = { nodes: [], edges: [] }
    expect(() => buildViewerScene(canvas, fakeMeasure)).not.toThrow()
    expect(buildViewerScene(canvas, fakeMeasure)).toEqual({ nodes: [] })
  })

  it('emits a shape node and paragraph content for a text node', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'text', x: 10, y: 20, width: 100, height: 50, text: 'hello' }],
      edges: [],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    expect(scene.nodes[0]).toMatchObject({ kind: 'shape', bbox: { x: 10, y: 20, w: 100, h: 50 } })
    expect(scene.nodes.some((n) => n.kind === 'paragraph')).toBe(true)
  })

  it('renders a text node with empty text as just its shape, without throwing', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' }],
      edges: [],
    }
    expect(() => buildViewerScene(canvas, fakeMeasure)).not.toThrow()
    const scene = buildViewerScene(canvas, fakeMeasure)
    expect(scene.nodes).toHaveLength(1)
    expect(scene.nodes[0]?.kind).toBe('shape')
  })

  it('emits a label text run for a file node', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'file', x: 0, y: 0, width: 10, height: 10, file: 'notes.md' }],
      edges: [],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    const label = scene.nodes.find((n) => n.kind === 'textRun')
    expect(label && 'text' in label ? label.text : undefined).toBe('notes.md')
  })

  it('emits a label text run for a link node', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'link', x: 0, y: 0, width: 10, height: 10, url: 'https://example.com' },
      ],
      edges: [],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    const label = scene.nodes.find((n) => n.kind === 'textRun')
    expect(label && 'text' in label ? label.text : undefined).toBe('https://example.com')
  })

  it('emits a label text run for a group node label', () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'group', x: 0, y: 0, width: 10, height: 10, label: 'Section A' }],
      edges: [],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    const label = scene.nodes.find((n) => n.kind === 'textRun')
    expect(label && 'text' in label ? label.text : undefined).toBe('Section A')
  })

  it('honors x-whiteboard ellipse shape as a radius on the shape node', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          text: '',
          'x-whiteboard': { kind: 'shape', shape: 'ellipse' },
        },
      ],
      edges: [],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    const shape = scene.nodes[0]
    expect(shape?.kind).toBe('shape')
    expect(shape && 'radius' in shape ? shape.radius : undefined).toBe(10)
  })

  it('routes an edge between two nodes', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' },
        { id: 'b', type: 'text', x: 100, y: 0, width: 10, height: 10, text: '' },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    expect(scene.nodes.some((n) => n.kind === 'edge')).toBe(true)
  })

  it('renders an edge whose endpoint node was filtered out without throwing', () => {
    // Bypasses the schema's dangling-reference guard deliberately: this
    // exercises routeEdge's own missing-endpoint fallback, not something a
    // schema-valid SpatialCanvas can express directly.
    const canvas = {
      nodes: [{ id: 'a', type: 'text' as const, x: 0, y: 0, width: 10, height: 10, text: '' }],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'missing' }],
    } as SpatialCanvas
    expect(() => buildViewerScene(canvas, fakeMeasure)).not.toThrow()
  })

  it('preserves document order: nodes before edges, each node in array order', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' },
        { id: 'b', type: 'text', x: 20, y: 0, width: 10, height: 10, text: '' },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    }
    const scene = buildViewerScene(canvas, fakeMeasure)
    const kinds = scene.nodes.map((n) => n.kind)
    expect(kinds.indexOf('edge')).toBe(kinds.length - 1)
  })
})
