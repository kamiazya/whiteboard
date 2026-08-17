import { describe, expect, it } from 'vitest'
import { parseSpatial } from './parse.js'

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
