import { describe, expect, it } from 'vitest'
import { readJsonCanvasText } from './read-json-canvas-text.js'
import { parseSpatial as parseWithCore } from './spatial-core.js'

/**
 * The two readers of JSON Canvas text answer one set of failure classes: the
 * core every daemon and web realm reads through, and the TypeScript reader the
 * widget keeps because its iframe has no core. The same assertions hold both,
 * so a document the viewer draws is one the daemon would have read.
 */
describe.each([
  ['the core', parseWithCore],
  ['the viewer reader', readJsonCanvasText],
] as const)('%s', (_reader, parseSpatial) => {
  describe('parseSpatial failure classes (total parser — never throws)', () => {
    it('non-JSON text -> stage "json-syntax"', () => {
      const result = parseSpatial('{not json')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.stage).toBe('json-syntax')
    })

    it('structurally invalid node (bad type) -> stage "json-canvas-schema"', () => {
      const result = parseSpatial(
        JSON.stringify({
          nodes: [{ id: 'n1', type: 'not-a-real-type', x: 0, y: 0, width: 10, height: 10 }],
          edges: [],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.stage).toBe('json-canvas-schema')
      expect(result.error.issues.length).toBeGreaterThan(0)
    })

    it('invalid edge (dangling fromNode) -> stage "json-canvas-schema"', () => {
      const result = parseSpatial(
        JSON.stringify({
          nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
          edges: [{ id: 'e1', fromNode: 'missing', toNode: 'n1' }],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.stage).toBe('json-canvas-schema')
    })

    it('duplicate node id -> stage "json-canvas-schema"', () => {
      const result = parseSpatial(
        JSON.stringify({
          nodes: [
            { id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
            { id: 'n1', type: 'text', x: 20, y: 0, width: 10, height: 10, text: 'b' },
          ],
          edges: [],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.stage).toBe('json-canvas-schema')
      expect(result.error.issues.map((issue) => issue.message)).toContain('duplicate node id "n1"')
    })

    it('duplicate edge id -> stage "json-canvas-schema"', () => {
      const result = parseSpatial(
        JSON.stringify({
          nodes: [
            { id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
            { id: 'n2', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'b' },
          ],
          edges: [
            { id: 'e1', fromNode: 'n1', toNode: 'n2' },
            { id: 'e1', fromNode: 'n2', toNode: 'n1' },
          ],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.stage).toBe('json-canvas-schema')
    })

    it('never throws on arbitrary garbage input', () => {
      for (const input of ['', 'null', '[]', '42', '"just a string"']) {
        expect(() => parseSpatial(input)).not.toThrow()
      }
    })

    it('accepts a minimal valid canvas', () => {
      const result = parseSpatial(JSON.stringify({ nodes: [], edges: [] }))
      expect(result.ok).toBe(true)
    })
  })

  describe('a file carrying the conversation it no longer may (ADR-0026 decision 1b)', () => {
    it('refuses an x-whiteboard.comments key by name rather than dropping it unread', () => {
      const result = parseSpatial(
        JSON.stringify({
          nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
          edges: [],
          'x-whiteboard': { comments: [{ id: 'c1', x: 1, y: 2, text: 'old export' }] },
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.stage).toBe('json-canvas-schema')
      expect(result.error.message).toMatch(/x-whiteboard\.comments/)
      expect(result.error.message).toMatch(/remove/i)
    })

    it('reads a file whose comments key holds nothing, since nothing is lost', () => {
      for (const comments of [[], null]) {
        const result = parseSpatial(
          JSON.stringify({
            nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
            edges: [],
            'x-whiteboard': { comments, tags: ['kept'] },
          }),
        )
        expect(result.ok, JSON.stringify(comments)).toBe(true)
        if (result.ok) expect(result.value.tags).toEqual(['kept'])
      }
    })

    it('reads the same file without the key, extension and all', () => {
      const result = parseSpatial(
        JSON.stringify({
          nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
          edges: [],
          'x-whiteboard': { tags: ['kept'] },
        }),
      )

      expect(result.ok && result.value.tags).toEqual(['kept'])
    })
  })
})
