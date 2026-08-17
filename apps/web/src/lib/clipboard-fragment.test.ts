// Pure clipboard-fragment helpers (editor-completeness slice 2): extract a
// self-contained fragment from a selection, and remint ids on paste so a
// fragment can land any number of times in any canvas without colliding.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { clipboardFragmentSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { extractClipboardFragment, remintClipboardFragment } from './clipboard-fragment.js'

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
    { id: 'c', type: 'text', x: 400, y: 0, width: 100, height: 50, text: 'c' },
  ],
  edges: [
    { id: 'ab', fromNode: 'a', toNode: 'b' },
    { id: 'bc', fromNode: 'b', toNode: 'c' },
  ],
}

describe('extractClipboardFragment', () => {
  it('keeps selected nodes in canvas (z) order and only fully-selected edges', () => {
    const fragment = extractClipboardFragment(canvas, new Set(['b', 'a']))
    expect(fragment.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    // 'bc' has an unselected endpoint and is dropped.
    expect(fragment.edges.map((edge) => edge.id)).toEqual(['ab'])
    expect(fragment.type).toBe('whiteboard/clipboard')
    expect(clipboardFragmentSchema.safeParse(fragment).success).toBe(true)
  })

  it('a cut extraction records boundary edges — the cut remembers its own cut surface', () => {
    const fragment = extractClipboardFragment(canvas, new Set(['a', 'b']), { cutId: 'cut-1' })
    expect(fragment.edges.map((edge) => edge.id)).toEqual(['ab'])
    // 'bc' crosses the border (b in, c out): carried as a boundary edge so a
    // same-canvas paste can reconnect it; a copy never records it.
    expect(fragment.cut).toEqual({
      id: 'cut-1',
      boundaryEdges: [{ id: 'bc', fromNode: 'b', toNode: 'c' }],
    })
    expect(clipboardFragmentSchema.safeParse(fragment).success).toBe(true)
    expect(extractClipboardFragment(canvas, new Set(['a', 'b'])).cut).toBeUndefined()
  })

  it('an empty or unknown selection yields an empty (still valid) fragment', () => {
    const fragment = extractClipboardFragment(canvas, new Set(['ghost']))
    expect(fragment.nodes).toEqual([])
    expect(fragment.edges).toEqual([])
    expect(clipboardFragmentSchema.safeParse(fragment).success).toBe(true)
  })
})

describe('remintClipboardFragment', () => {
  const seq = () => {
    let n = 0
    return () => `minted-${++n}`
  }

  it('remints every node id, remaps edge endpoints, and avoids the blocklist', () => {
    const fragment = extractClipboardFragment(canvas, new Set(['a', 'b']))
    const { nodes, edges } = remintClipboardFragment(fragment, seq(), new Set(['a', 'b', 'c']))
    expect(nodes.map((node) => node.id)).toEqual(['minted-1', 'minted-2'])
    expect(edges).toHaveLength(1)
    expect(edges[0].fromNode).toBe('minted-1')
    expect(edges[0].toNode).toBe('minted-2')
    expect(edges[0].id).not.toBe('ab')
    // Non-id fields survive untouched.
    expect(nodes[0]).toMatchObject({ type: 'text', text: 'a', x: 0, y: 0 })
  })

  it('skips createId values already present in the blocklist or the minted set', () => {
    const fragment = extractClipboardFragment(canvas, new Set(['a']))
    let calls = 0
    const collidingThenFresh = () => {
      calls += 1
      return calls === 1 ? 'taken' : 'fresh'
    }
    const { nodes } = remintClipboardFragment(fragment, collidingThenFresh, new Set(['taken']))
    expect(nodes[0].id).toBe('fresh')
  })

  it('drops edges whose endpoints are not both present in the fragment (defensive on foreign input)', () => {
    const foreign = {
      ...extractClipboardFragment(canvas, new Set(['a'])),
      edges: [{ id: 'x', fromNode: 'a', toNode: 'ghost' }],
    }
    const { edges } = remintClipboardFragment(foreign, seq(), new Set())
    expect(edges).toEqual([])
  })

  fcTest.prop(
    [fc.subarray(['a', 'b', 'c'] as const, { minLength: 0 }), fc.integer({ min: 0, max: 20 })],
    withDefaults(),
  )(
    'extract-then-remint: node count preserved, endpoints resolve, no collisions',
    (picked, seed) => {
      const fragment = extractClipboardFragment(canvas, new Set(picked))
      let n = seed
      const { nodes, edges } = remintClipboardFragment(
        fragment,
        () => `id-${++n}`,
        new Set(canvas.nodes.map((node) => node.id)),
      )
      expect(nodes).toHaveLength(fragment.nodes.length)
      const minted = new Set(nodes.map((node) => node.id))
      expect(minted.size).toBe(nodes.length)
      for (const id of minted) expect(['a', 'b', 'c']).not.toContain(id)
      for (const edge of edges) {
        expect(minted.has(edge.fromNode)).toBe(true)
        expect(minted.has(edge.toNode)).toBe(true)
      }
    },
  )
})
