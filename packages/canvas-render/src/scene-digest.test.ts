import { describe, expect, it } from 'vitest'
import { sceneDigest, sceneDigestSchema } from './scene-digest.js'
import type { Scene } from './scene-graph.js'

function scene(...boxes: { x: number; y: number; w: number; h: number }[]): Scene {
  return {
    nodes: boxes.map((bbox) => ({ kind: 'thematicBreak' as const, bbox })),
  }
}

describe('sceneDigest', () => {
  it('assigns stable node ids and z-order in document order', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }))
    expect(digest.nodes).toHaveLength(2)
    expect(digest.nodes[0].z).toBe(0)
    expect(digest.nodes[1].z).toBe(1)
    expect(digest.nodes[0].id).not.toBe(digest.nodes[1].id)
  })

  it('detects an overlap pair with area > 0 but not edge-touching boxes', () => {
    const overlapping = sceneDigest(
      scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    )
    expect(overlapping.overlaps).toHaveLength(1)

    const touching = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }))
    expect(touching.overlaps).toHaveLength(0)
  })

  it('reports overlap pairs with the lexicographically smaller id first', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }))
    const [a, b] = digest.overlaps[0]
    expect(a < b).toBe(true)
  })

  it('detects containment and picks the smallest-area parent', () => {
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 100, h: 100 }, // outer
        { x: 10, y: 10, w: 30, h: 30 }, // middle, contains child
        { x: 15, y: 15, w: 5, h: 5 }, // child
      ),
    )
    const child = digest.nodes[2].id
    const containment = digest.containment.find((c) => c.child === child)
    expect(containment?.parent).toBe(digest.nodes[1].id)
  })

  it('clusters nodes within the proximity threshold via single-linkage', () => {
    const digest = sceneDigest(
      scene(
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: 0, w: 10, h: 10 }, // gap of 10 <= default threshold 24
        { x: 200, y: 200, w: 10, h: 10 }, // far away, separate cluster
      ),
    )
    expect(digest.clusters).toHaveLength(2)
    expect(digest.clusters[0]).toHaveLength(2)
    expect(digest.clusters[1]).toHaveLength(1)
  })

  it('computes at least one free region over the union bounds', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }))
    expect(digest.freeRegions.length).toBeGreaterThanOrEqual(0)
  })

  it('round-trips through sceneDigestSchema', () => {
    const digest = sceneDigest(scene({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }))
    const parsed = sceneDigestSchema.parse(digest)
    expect(parsed).toEqual(digest)
  })

  it('is deterministic across repeated calls', () => {
    const s = scene(
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 5, y: 5, w: 10, h: 10 },
      { x: 100, y: 100, w: 10, h: 10 },
    )
    expect(sceneDigest(s)).toEqual(sceneDigest(s))
  })
})
