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

function mapCache(): SpatialContentCache & {
  store: Map<string, FittedBlocks>
  hits: () => number
} {
  const store = new Map<string, FittedBlocks>()
  let hits = 0
  return {
    store,
    hits: () => hits,
    get: (key) => {
      const value = store.get(key)
      if (value !== undefined) hits += 1
      return value
    },
    set: (key, value) => store.set(key, value),
  }
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

/**
 * An edit APPLIED to a node the cache has already seen. The key is
 * `[width, height, text, outline]`, so two independently generated nodes
 * agree on it about never: the earlier shape of this property drew its
 * second canvas from `nodeArb` and scored 0 cache hits in 200 runs, which
 * made the `body = cached` branch — the whole subject — unreachable.
 * Corrupting that branch left the property green while the move example
 * above went red.
 *
 * `move` is the case the key's own contract is about (position is
 * deliberately absent, so a moved node hits); `resize` and `retext` are the
 * misses that keep both sides of the branch in the domain.
 */
const editArb = fc.oneof(
  fc.record({
    kind: fc.constant('move' as const),
    dx: fc.integer({ min: -300, max: 300 }),
    dy: fc.integer({ min: -300, max: 300 }),
  }),
  fc.record({
    kind: fc.constant('resize' as const),
    w: fc.integer({ min: 30, max: 320 }),
    h: fc.integer({ min: 20, max: 200 }),
  }),
  fc.record({ kind: fc.constant('retext' as const), text: bodyArb }),
)

type Edit =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; w: number; h: number }
  | {
      kind: 'retext'
      text: string
    }

function applyEdit(node: SpatialNode, edit: Edit): SpatialNode {
  if (edit.kind === 'move') return { ...node, x: node.x + edit.dx, y: node.y + edit.dy }
  if (edit.kind === 'resize') return { ...node, width: edit.w, height: edit.h }
  return { ...node, type: 'text', text: edit.text } as SpatialNode
}

describe('layoutSpatialCanvas content cache (PBT)', () => {
  fcTest.prop([fc.array(nodeArb('n'), { minLength: 1, maxLength: 3 }), editArb], withDefaults())(
    'a shared warm cache never changes any layout across a random edit sequence',
    (nodes, edit) => {
      const cache = mapCache()
      const before = nodes.map((n, i) => ({ ...n, id: `n${i}` }))
      const after = [applyEdit(before[0] as SpatialNode, edit), ...before.slice(1)]
      // Back to the first canvas last, so every key is warm however the edit
      // went — an undo is also the commonest real sequence.
      const canvases: SpatialCanvas[] = [
        { nodes: before, edges: [] },
        { nodes: after, edges: [] },
        { nodes: before, edges: [] },
      ]
      for (const canvas of canvases) {
        const withCache = layoutSpatialCanvas(canvas, options({ contentCache: cache }))
        const fresh = layoutSpatialCanvas(canvas, options())
        expect(JSON.stringify(withCache)).toBe(JSON.stringify(fresh))
      }
      // The trigger, asserted beside the outcome: a run that never read a
      // warm entry has not exercised the branch this property is about.
      expect(cache.hits()).toBeGreaterThan(0)
    },
  )
})
