import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { sceneDigestSchema } from '../scene-digest-schema.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSceneDigest } from './query-switch.js'

const options = () => ({
  core: testLayoutCore(),
  measure: createFakeMeasure(),
  appearance: createSpatialTheme({ mode: 'light' }),
})

const node = (id: string, x: number, y: number) =>
  textNode({ id, x, y, width: 120, height: 60, text: id })

describe('the spatial digest through the Rust core', () => {
  it('reports what a laid-out canvas holds, in the schema a tool publishes', () => {
    const canvas: SpatialCanvas = {
      nodes: [node('a', 0, 0), node('b', 60, 20), node('c', 900, 900)],
      edges: [],
    }
    const digest = layoutSceneDigest(canvas, options())
    expect(sceneDigestSchema.parse(digest)).toEqual(digest)
    expect(digest.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(digest.overlaps).toEqual([['a', 'b']])
  })

  it('answers a layout the core refused as a digest that derived nothing, and tells onRefused', () => {
    const many: SpatialCanvas = {
      nodes: Array.from({ length: 4200 }, (_, i) => node(`n${i}`, i, 0)),
      edges: [],
    }
    const refusals: unknown[] = []
    const digest = layoutSceneDigest(many, {
      ...options(),
      onRefused: (refusal) => refusals.push(refusal),
    })
    expect(digest).toEqual({
      nodes: [],
      overlaps: [],
      containment: [],
      clusters: [],
      freeRegions: [],
      partial: true,
    })
    expect(refusals).toEqual([{ code: 'input-too-large', reason: 'too-many-elements' }])

    // Each refusal is its own answer: a caller's edit to one never reaches the next.
    digest.partial = false
    digest.nodes.push({
      id: 'x',
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      z: 0,
    })
    const again = layoutSceneDigest(many, options())
    expect(again.partial).toBe(true)
    expect(again.nodes).toEqual([])
  })
})
