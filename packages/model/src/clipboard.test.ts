import { describe, expect, it } from 'vitest'
import { clipboardFragmentSchema } from './clipboard.js'

const NODE = { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }
const NODE2 = { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'yo' }

describe('clipboardFragmentSchema', () => {
  it('accepts a typed fragment of nodes, edges, and inline file assets', () => {
    const fragment = {
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: [
        NODE,
        NODE2,
        { id: 'n3', type: 'file', x: 400, y: 0, width: 100, height: 50, file: 'asset:img' },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
      files: {
        'asset:img': { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
      },
    }
    const parsed = clipboardFragmentSchema.parse(fragment)
    expect(parsed).toEqual(fragment)
  })

  it('accepts a minimal fragment without files', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE],
        edges: [],
      }).success,
    ).toBe(true)
  })

  it('rejects a wrong or missing discriminant/version (foreign JSON must not parse)', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'excalidraw/clipboard',
        version: 1,
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 2,
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false)
    expect(clipboardFragmentSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false)
  })

  it('rejects duplicate node ids and edges with endpoints missing from the fragment', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE, { ...NODE2, id: 'n1' }],
        edges: [],
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [NODE],
        edges: [{ id: 'e1', fromNode: 'n1', toNode: 'ghost' }],
      }).success,
    ).toBe(false)
  })

  it('accepts a cut fragment whose boundary edges each cross the selection border', () => {
    const fragment = {
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: [NODE],
      edges: [],
      cut: {
        id: 'cut-1',
        // n1 is in the fragment; 'outside' is the peer left on the canvas.
        boundaryEdges: [{ id: 'e-b', fromNode: 'n1', toNode: 'outside' }],
      },
    }
    expect(clipboardFragmentSchema.safeParse(fragment).success).toBe(true)
  })

  it('rejects a boundary edge that does not cross the border (both endpoints in, or none)', () => {
    const base = { type: 'whiteboard/clipboard', version: 1, nodes: [NODE, NODE2], edges: [] }
    expect(
      clipboardFragmentSchema.safeParse({
        ...base,
        cut: { id: 'cut-1', boundaryEdges: [{ id: 'e-b', fromNode: 'n1', toNode: 'n2' }] },
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        ...base,
        cut: { id: 'cut-1', boundaryEdges: [{ id: 'e-b', fromNode: 'x', toNode: 'y' }] },
      }).success,
    ).toBe(false)
  })

  it('rejects extra keys and malformed file assets (strict envelope)', () => {
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [],
        edges: [],
        surprise: true,
      }).success,
    ).toBe(false)
    expect(
      clipboardFragmentSchema.safeParse({
        type: 'whiteboard/clipboard',
        version: 1,
        nodes: [],
        edges: [],
        files: { k: { mimeType: '', dataBase64: 'x' } },
      }).success,
    ).toBe(false)
  })
})
