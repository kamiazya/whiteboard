import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { parseViewerScene, serializeViewerScene, type ViewerScene } from './scene.js'

const emptyCanvas: ViewerScene = { nodes: [], edges: [] }

/**
 * `parseViewerScene` takes the JSON Canvas WIRE shape — it IS the codec
 * parser — so every fixture in this describe spells `type` plus the kind's
 * own field. The `serializeViewerScene` describe below takes a `ViewerScene`,
 * which is the MODEL, and uses the node builders. One file, both contracts,
 * and telling them apart is the whole point of ADR-0038 decision 3 leaving
 * the wire where it was.
 */
describe('parseViewerScene', () => {
  it('accepts a bare object canvas ({}) as an empty canvas', () => {
    const result = parseViewerScene({})
    expect(result).toEqual({ ok: true, value: emptyCanvas })
  })

  it('accepts a nodes-only canvas object', () => {
    const canvas = {
      nodes: [{ id: 'n1', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50 }],
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
        { id: 'a', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b', type: 'text', text: '', x: 20, y: 20, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    })
    const result = parseViewerScene(text)
    expect(result.ok).toBe(true)
  })

  it('accepts a node carrying the x-whiteboard embed extension', () => {
    const canvas = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          text: '',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
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
        textNode({ id: 'dup', x: 0, y: 0, width: 1, height: 1, text: '' }),
        textNode({ id: 'dup', x: 0, y: 0, width: 1, height: 1, text: '' }),
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
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 1, height: 1, text: '' })],
      edges: [
        {
          id: 'e1',
          from: { node: 'a' },
          to: { node: 'missing' },
        },
      ],
    }
    const result = parseViewerScene(canvas)
    expect(result.ok).toBe(false)
  })

  it('rejects non-integer geometry', () => {
    const canvas = {
      nodes: [textNode({ id: 'a', x: 0.5, y: 0, width: 1, height: 1, text: '' })],
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
        textNode({
          id: 'n1',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'hi',
          embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        }),
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
        textNode({
          id: 'n1',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: 'hi',
          embed: { documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
        }),
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
