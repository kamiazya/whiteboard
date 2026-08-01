import { describe, expect, it } from 'vitest'
import { MIN_SCENE_EXTENT_PX, sceneBounds } from './scene-bounds.js'
import type { Scene } from './scene-graph.js'

describe('sceneBounds', () => {
  it('returns the documented fallback for an empty scene', () => {
    const scene: Scene = { nodes: [] }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('returns exactly one node bbox when the scene has a single non-degenerate node', () => {
    const scene: Scene = {
      nodes: [{ kind: 'thematicBreak', bbox: { x: 10, y: 20, w: 100, h: 5 } }],
    }
    expect(sceneBounds(scene)).toEqual({ x: 10, y: 20, w: 100, h: 5 })
  })

  it('unions two disjoint nodes, including negative coordinates', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: -50, y: -10, w: 10, h: 10 } },
        { kind: 'thematicBreak', bbox: { x: 100, y: 50, w: 20, h: 20 } },
      ],
    }
    // union spans from (-50,-10) to (120,70)
    expect(sceneBounds(scene)).toEqual({ x: -50, y: -10, w: 170, h: 80 })
  })

  it('clamps a zero-size scene to the minimum extent while preserving position', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 5, y: 5, w: 0, h: 0 } },
        { kind: 'thematicBreak', bbox: { x: 5, y: 5, w: 0, h: 0 } },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(5)
    expect(bounds.y).toBe(5)
    expect(bounds.w).toBe(MIN_SCENE_EXTENT_PX)
    expect(bounds.h).toBe(MIN_SCENE_EXTENT_PX)
  })

  it('normalizes a negative w/h bbox rather than trusting it as an extent', () => {
    const scene: Scene = {
      nodes: [{ kind: 'thematicBreak', bbox: { x: 100, y: 100, w: -50, h: -20 } }],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.x).toBe(50)
    expect(bounds.y).toBe(80)
    expect(bounds.w).toBe(50)
    expect(bounds.h).toBe(20)
  })

  it('skips a bbox with a non-finite field, keeping the rest of the scene', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: Number.NaN, y: 0, w: 10, h: 10 } },
        { kind: 'thematicBreak', bbox: { x: 200, y: 200, w: 10, h: 10 } },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 200, y: 200, w: 10, h: 10 })
  })

  it('falls back to the documented default when every bbox is non-finite', () => {
    const scene: Scene = {
      nodes: [{ kind: 'thematicBreak', bbox: { x: Number.POSITIVE_INFINITY, y: 0, w: 10, h: 10 } }],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('derives bounds from edge path points, ignoring an empty path', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 50, y: 30 },
          ],
          fromSide: 'right',
          toSide: 'left',
        },
        { kind: 'edge', id: 'e2', path: [], fromSide: 'top', toSide: 'bottom' },
      ],
    }
    expect(sceneBounds(scene)).toEqual({ x: 0, y: 0, w: 50, h: 30 })
  })

  it('widens the bounds when a nested descendant lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'group',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when a blockquote child lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'blockquote',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('widens the bounds when an embedResolved child lies outside its parent bbox', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'embedResolved',
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          canvasId: 'other-canvas',
          children: [{ kind: 'thematicBreak', bbox: { x: 500, y: 500, w: 10, h: 10 } }],
        },
      ],
    }
    const bounds = sceneBounds(scene)
    expect(bounds.w).toBeGreaterThanOrEqual(510)
    expect(bounds.h).toBeGreaterThanOrEqual(510)
  })

  it('does not overflow the stack on deep nesting (iterative walk)', () => {
    const DEPTH = 10000
    let node: Scene['nodes'][number] = { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 1, h: 1 } }
    for (let i = 0; i < DEPTH; i++) {
      node = { kind: 'group', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: [node] }
    }
    const scene: Scene = { nodes: [node] }
    expect(() => sceneBounds(scene)).not.toThrow()
  })
})
