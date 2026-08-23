import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import type { MeasureText } from '../measure.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import type { FittedBlocks } from './nodes/mdast-blocks.js'
import {
  layoutSpatialCanvas,
  type SpatialContentCache,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const textNode = (
  id: string,
  x: number,
  y: number,
  text: string,
  size: { w?: number; h?: number } = {},
): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: size.w ?? 240,
  height: size.h ?? 140,
  text,
})

function mapCache(): SpatialContentCache & { store: Map<string, FittedBlocks> } {
  const store = new Map<string, FittedBlocks>()
  return { store, get: (key) => store.get(key), set: (key, value) => store.set(key, value) }
}

function options(
  overrides: Partial<SpatialLayoutOptions> = {},
  measure: MeasureText = createFakeMeasure(),
): SpatialLayoutOptions {
  return { measure, appearance: createSpatialTheme({ mode: 'light' }), ...overrides }
}

function countingMeasure(): { measure: MeasureText; calls: () => number } {
  const inner = createFakeMeasure()
  let n = 0
  return {
    measure: (text, font) => {
      n += 1
      return inner(text, font)
    },
    calls: () => n,
  }
}

const BODY = '# Title\n\nA paragraph long enough to wrap across a couple of lines in the box.'

describe('layoutSpatialCanvas content cache', () => {
  it('a warm cache reproduces the uncached scene exactly, including after a move', () => {
    const canvas: SpatialCanvas = { nodes: [textNode('a', 40, 40, BODY)], edges: [] }
    const cache = mapCache()
    const cold = layoutSpatialCanvas(canvas, options({ contentCache: cache }))
    expect(JSON.stringify(cold)).toBe(JSON.stringify(layoutSpatialCanvas(canvas, options())))

    const moved: SpatialCanvas = { nodes: [textNode('a', 300, 500, BODY)], edges: [] }
    const warm = layoutSpatialCanvas(moved, options({ contentCache: cache }))
    expect(JSON.stringify(warm)).toBe(JSON.stringify(layoutSpatialCanvas(moved, options())))
  })

  it('a warm cache lays text-node content out without a single measure call', () => {
    const canvas: SpatialCanvas = {
      nodes: [textNode('a', 0, 0, BODY), textNode('b', 400, 0, `${BODY} And more.`)],
      edges: [],
    }
    const cache = mapCache()
    const cold = countingMeasure()
    layoutSpatialCanvas(canvas, options({ contentCache: cache }, cold.measure))
    expect(cold.calls()).toBeGreaterThan(0)

    const warm = countingMeasure()
    layoutSpatialCanvas(canvas, options({ contentCache: cache }, warm.measure))
    expect(warm.calls()).toBe(0)
  })

  it('distinguishes text and box size in the key — a changed node recomputes', () => {
    const cache = mapCache()
    const base: SpatialCanvas = { nodes: [textNode('a', 0, 0, BODY)], edges: [] }
    layoutSpatialCanvas(base, options({ contentCache: cache }))

    for (const edited of [
      { nodes: [textNode('a', 0, 0, `${BODY}!`)], edges: [] },
      { nodes: [textNode('a', 0, 0, BODY, { w: 300 })], edges: [] },
      { nodes: [textNode('a', 0, 0, BODY, { h: 80 })], edges: [] },
    ] satisfies SpatialCanvas[]) {
      const counting = countingMeasure()
      layoutSpatialCanvas(edited, options({ contentCache: cache }, counting.measure))
      expect(counting.calls()).toBeGreaterThan(0)
    }
  })

  it('does not cache the parse-failure fallback, and reports the degradation every run', () => {
    const cache = mapCache()
    const parseBody = () => {
      throw new Error('bad body')
    }
    const canvas: SpatialCanvas = { nodes: [textNode('a', 0, 0, 'x')], edges: [] }
    const onDegrade = vi.fn()
    layoutSpatialCanvas(canvas, options({ contentCache: cache, parseBody, onDegrade }))
    layoutSpatialCanvas(canvas, options({ contentCache: cache, parseBody, onDegrade }))
    expect(cache.store.size).toBe(0)
    expect(onDegrade).toHaveBeenCalledTimes(2)
  })
})

const bodyArb = fc.oneof(
  fc.constant(''),
  fc.string({ maxLength: 40 }),
  fc
    .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 6 })
    .map((words) => `# H\n\n${words.join(' ')}`),
)

const nodeArb = (id: string): fc.Arbitrary<SpatialNode> =>
  fc
    .record({
      x: fc.integer({ min: -200, max: 600 }),
      y: fc.integer({ min: -200, max: 600 }),
      w: fc.integer({ min: 30, max: 320 }),
      h: fc.integer({ min: 20, max: 200 }),
      text: bodyArb,
    })
    .map(({ x, y, w, h, text }) => textNode(id, x, y, text, { w, h }))

describe('layoutSpatialCanvas content cache (PBT)', () => {
  fcTest.prop(
    [fc.array(nodeArb('n'), { minLength: 1, maxLength: 3 }), nodeArb('n')],
    withDefaults(),
  )(
    'a shared warm cache never changes any layout across a random edit sequence',
    (nodes, edited) => {
      const cache = mapCache()
      const canvases: SpatialCanvas[] = [
        { nodes: nodes.map((n, i) => ({ ...n, id: `n${i}` })), edges: [] },
        { nodes: [{ ...edited, id: 'n0' }], edges: [] },
      ]
      for (const canvas of canvases) {
        const withCache = layoutSpatialCanvas(canvas, options({ contentCache: cache }))
        const fresh = layoutSpatialCanvas(canvas, options())
        expect(JSON.stringify(withCache)).toBe(JSON.stringify(fresh))
      }
    },
  )
})
