import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CanvasLayoutCore } from '../../canvas-core.js'
import type { FragmentAsk, FragmentEntry } from '../../fragment-ask.js'
import type { SpatialContentCache, SpatialLayoutOptions } from '../../layout/layout-options.js'
import type { FittedBlocks } from '../../layout/nodes/mdast-blocks.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { describeMeasure } from '../../measure.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { fakeLayoutCore } from '../fake-layout-core.js'
import { createFakeMeasure } from '../fake-measure.js'
import { built, requireWasm, wasmBytes } from './glue.js'
import { layoutCases } from './layout-cases.js'

/**
 * The content cache the core keeps for a caller's cache object (ADR-0054
 * step 7, S15n): a layout handed a `contentCache` names a surface, and the
 * core lays out again only the bodies that surface does not hold. A cache may
 * change timings and never what is drawn, so every layout here, warm or cold,
 * is held to the TypeScript composer's.
 */
describe.runIf(built)('the whole layout over a content cache kept in the core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })
  const answered = { compared: 0, refused: [] as string[] }
  const counting: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight, measure, cache) {
      const answer = real.layoutSpatialCanvas(request, highlight, measure, cache)
      if ('refused' in answer) answered.refused.push(answer.refused.reason)
      else answered.compared += 1
      return answer
    },
  }
  const lay = (canvas: SpatialCanvas, options: SpatialLayoutOptions) => {
    const core = fakeLayoutCore({ routing: real, layout: counting })
    const asks: FragmentAsk[][] = []
    const laid = layoutSpatialCanvasWithAnchors(canvas, {
      ...options,
      core,
      ...(options.fragments === undefined
        ? {}
        : { onFragmentsAsked: (asked: readonly FragmentAsk[]) => asks.push([...asked]) }),
    })
    return { ...laid, asks }
  }
  const memo = (): SpatialContentCache => {
    const held = new Map<string, FittedBlocks>()
    return { get: (key) => held.get(key), set: (key, value) => void held.set(key, value) }
  }
  /** `canvas` with its first node moved `dx` to the right. */
  const moved = (canvas: SpatialCanvas, dx: number): SpatialCanvas => ({
    ...canvas,
    nodes: canvas.nodes.map((node, at) => (at === 0 ? { ...node, x: node.x + dx } : node)),
  })

  it('draws every case as the TypeScript does, laid out again over a warm cache', () => {
    answered.compared = 0
    answered.refused.length = 0
    const cases = layoutCases(12)
    for (const { name, canvas, options } of cases) {
      const cache = memo()
      for (const dx of [0, 24, 48]) {
        const board = moved(canvas, dx)
        const reference = layoutSpatialCanvasWithAnchors(board, options)
        const answered = lay(board, { ...options, contentCache: cache })
        expect(answered.scene, `${name} +${dx}`).toEqual(reference.scene)
      }
    }
    expect(answered.compared).toBe(3 * cases.length)
    expect(answered.refused).toEqual([])
  })

  const measure = createFakeMeasure()
  const appearance = createSpatialTheme({ mode: 'light' })
  const MATH = '$$\nx^2\n$$\n\nwords beside it'
  const board: SpatialCanvas = {
    nodes: [
      textNode({ id: 'm', x: 0, y: 0, width: 260, height: 200, text: MATH }),
      textNode({ id: 'p', x: 320, y: 0, width: 260, height: 200, text: 'plain prose' }),
    ] as SpatialNode[],
    edges: [],
  }
  const X2: FragmentEntry = ['math:x^2', { svg: '<g data-x2/>', width: 40, height: 20 }]

  it('never serves a body drawn without a table to a layout with one, nor one that asked it', () => {
    const cache = memo()
    const base = { measure, appearance, contentCache: cache }
    const fallback = lay(board, base)
    expect(JSON.stringify(fallback.scene)).not.toContain('data-x2')
    for (const fragments of [[], [X2], []] as FragmentEntry[][]) {
      const options = { ...base, fragments }
      const reference = layoutSpatialCanvasWithAnchors(board, { ...options, contentCache: memo() })
      const laid = lay(board, options)
      expect(laid.scene, JSON.stringify(fragments)).toEqual(reference.scene)
      // The body that asked the table was laid out again, so it asked again.
      expect(laid.asks).toEqual(fragments.length === 0 ? [[{ kind: 'math', value: 'x^2' }]] : [])
    }
  })

  it('never serves a body measured by one measurer to a layout measured by another', () => {
    const cache = memo()
    const wide = createFakeMeasure(0.9)
    const hosted = describeMeasure((text, font) => wide(text, font), { kind: 'host' })
    for (const each of [measure, hosted, wide, measure]) {
      const options = { measure: each, appearance, contentCache: cache }
      const reference = layoutSpatialCanvasWithAnchors(board, { measure: each, appearance })
      const laid = lay(board, options)
      expect(laid.scene).toEqual(reference.scene)
    }
    const dark = createSpatialTheme({ mode: 'dark' })
    const reference = layoutSpatialCanvasWithAnchors(board, { measure, appearance: dark })
    expect(lay(board, { measure, appearance: dark, contentCache: cache }).scene).toEqual(
      reference.scene,
    )
  })
})
