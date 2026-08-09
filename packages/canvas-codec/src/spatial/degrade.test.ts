import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { spatialCanvasSchema } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { strictDegrade } from './degrade.js'

const baseNode = { id: 'n1', x: 0, y: 0, width: 10, height: 10 }

describe('strictDegrade', () => {
  it('drops x-whiteboard from an extension-carrier node', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    }

    const degraded = strictDegrade(canvas)
    expect(degraded.nodes[0]).not.toHaveProperty('x-whiteboard')
    expect(spatialCanvasSchema.safeParse(degraded).success).toBe(true)
  })

  it('drops x-whiteboard from a shape-carrier node', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    }

    const degraded = strictDegrade(canvas)
    expect(degraded.nodes[0]).not.toHaveProperty('x-whiteboard')
    expect(spatialCanvasSchema.safeParse(degraded).success).toBe(true)
  })

  it('keeps file/subpath but drops x-whiteboard.canvasId from an embed file-node', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        {
          ...baseNode,
          type: 'file',
          file: 'other.md',
          subpath: '#heading',
          'x-whiteboard': { kind: 'embed', canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        },
      ],
      edges: [],
    }

    const degraded = strictDegrade(canvas)
    const [node] = degraded.nodes
    expect(node).not.toHaveProperty('x-whiteboard')
    expect(node).toMatchObject({ file: 'other.md', subpath: '#heading' })
    expect(spatialCanvasSchema.safeParse(degraded).success).toBe(true)
  })

  it('leaves edges unchanged', () => {
    const canvas: SpatialCanvas = {
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
    const canvas: SpatialCanvas = {
      nodes: [
        {
          ...baseNode,
          type: 'text',
          text: '',
          'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    }

    expect(strictDegrade(strictDegrade(canvas))).toEqual(strictDegrade(canvas))
  })
})
