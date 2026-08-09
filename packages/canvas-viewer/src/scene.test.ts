import { describe, expect, it } from 'vitest'
import { parseViewerScene, serializeViewerScene, type ViewerScene } from './scene.js'

const emptyCanvas: ViewerScene = { nodes: [], edges: [] }

describe('parseViewerScene', () => {
  it('accepts a bare object canvas ({}) as an empty canvas', () => {
    const result = parseViewerScene({})
    expect(result).toEqual({ ok: true, value: emptyCanvas })
  })

  it('accepts a nodes-only canvas object', () => {
    const canvas = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }],
    }
    const result = parseViewerScene(canvas)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.nodes).toHaveLength(1)
    }
  })

  it('accepts a nodes+edges JSON string via the codec parser', () => {
    const text = JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' },
        { id: 'b', type: 'text', x: 20, y: 20, width: 10, height: 10, text: '' },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    })
    const result = parseViewerScene(text)
    expect(result.ok).toBe(true)
  })

  it('accepts an x-whiteboard freehand/shape node', () => {
    const canvas = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: '',
          'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
    }
    const result = parseViewerScene(canvas)
    expect(result.ok).toBe(true)
  })

  it('rejects malformed JSON with the json-syntax stage and no raw throw', () => {
    const result = parseViewerScene('{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.stage).toBe('json-syntax')
    }
  })

  it('rejects a duplicate node id with the json-canvas-schema stage', () => {
    const canvas = {
      nodes: [
        { id: 'dup', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' },
        { id: 'dup', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' },
      ],
    }
    const result = parseViewerScene(canvas)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.stage).toBe('json-canvas-schema')
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  it('rejects an edge referencing a nonexistent node', () => {
    const canvas = {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' }],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'missing' }],
    }
    const result = parseViewerScene(canvas)
    expect(result.ok).toBe(false)
  })

  it('rejects non-integer geometry', () => {
    const canvas = {
      nodes: [{ id: 'a', type: 'text', x: 0.5, y: 0, width: 1, height: 1, text: '' }],
    }
    const result = parseViewerScene(canvas)
    expect(result.ok).toBe(false)
  })

  it('never throws for non-object garbage input', () => {
    expect(() => parseViewerScene('not json')).not.toThrow()
    expect(() => parseViewerScene(null)).not.toThrow()
    expect(() => parseViewerScene(42)).not.toThrow()
    expect(parseViewerScene(null).ok).toBe(false)
    expect(parseViewerScene(42).ok).toBe(false)
  })
})

describe('serializeViewerScene', () => {
  it('round-trips an extended-mode canvas through parseViewerScene', () => {
    const canvas: ViewerScene = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'hi',
          'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    }
    const json = serializeViewerScene(canvas, 'extended')
    const result = parseViewerScene(json)
    expect(result).toEqual({ ok: true, value: canvas })
  })

  it('strict mode drops x-whiteboard extension data', () => {
    const canvas: ViewerScene = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'hi',
          'x-whiteboard': { kind: 'embed', canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        },
      ],
      edges: [],
    }
    const json = serializeViewerScene(canvas, 'strict')
    const result = parseViewerScene(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.nodes[0]).not.toHaveProperty('x-whiteboard')
    }
  })
})
