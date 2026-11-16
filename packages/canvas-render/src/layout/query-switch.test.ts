import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { QueryAnswer, QueryRequest } from '../query-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import type { CoreImpl, CoreMismatch, LayoutCore } from './edges/layout-core.js'
import { fittedTextNodeHeight } from './fitted-height.js'
import { queryEdgeLabelPlacement, queryOutlineContentBox } from './queries.js'
import { layoutSpatialEdges, naturalNodeContentSize } from './spatial-canvas.js'

/** A core whose query entry answers `answer`, recording what it was asked and what it reported. */
function fake(impl: CoreImpl, answer: (request: QueryRequest) => QueryAnswer) {
  const asked: QueryRequest[] = []
  const reports: CoreMismatch[] = []
  const core: LayoutCore = {
    routing: {
      routeLayout: () => {
        throw new Error('routing is not asked')
      },
    },
    query: {
      layoutQuery: (request) => {
        asked.push(request)
        return answer(request)
      },
    },
    impl: { routeLayout: 'ts', layoutQuery: impl },
    onMismatch: (report) => reports.push(report),
  }
  return { core, asked, reports }
}

const box = { x: 0, y: 0, w: 100, h: 50 }
const node = textNode({ id: 'n', x: 0, y: 0, width: 160, height: 80, text: 'two words' })
const measure = createFakeMeasure()
const appearance = createSpatialTheme({ mode: 'dark' })

describe('the query switch', () => {
  it('asks nothing under ts, and the core answers under rust', () => {
    const quiet = fake('ts', () => ({ numbers: [[1, 2, 3, 4]] }))
    expect(queryOutlineContentBox(quiet.core, undefined, box)).toEqual(box)
    expect(quiet.asked).toEqual([])
    const rust = fake('rust', () => ({ numbers: [[1, 2, 3, 4]] }))
    expect(queryOutlineContentBox(rust.core, 'visual.ellipse', box)).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    })
    expect(rust.asked).toEqual([
      { query: 'outline-content-box', shape: 'visual.ellipse', box: [0, 0, 100, 50] },
    ])
    expect(rust.reports).toEqual([])
  })

  it('answers from the TypeScript when the core declines, throws or answers another shape', () => {
    const declined = fake('rust', () => ({ declined: 'body' }))
    expect(queryOutlineContentBox(declined.core, undefined, box)).toEqual(box)
    expect(declined.reports).toEqual([{ fn: 'layoutQuery', kind: 'declined', reason: 'body' }])
    const thrown = fake('rust', () => {
      throw new Error('trap')
    })
    expect(queryOutlineContentBox(thrown.core, undefined, box)).toEqual(box)
    expect(thrown.reports.map((r) => r.kind)).toEqual(['refused'])
    const shaped = fake('rust', () => ({ numbers: [[1, 2, 3]] }))
    expect(queryOutlineContentBox(shaped.core, undefined, box)).toEqual(box)
    expect(shaped.reports.map((r) => r.kind)).toEqual(['refused'])
  })

  it('reports where differential parts, and answers with the TypeScript', () => {
    const { core, reports } = fake('differential', () => ({ numbers: [[0, 0, 100, -0]] }))
    expect(queryOutlineContentBox(core, undefined, box)).toEqual(box)
    expect(reports).toEqual([
      expect.objectContaining({ fn: 'layoutQuery', kind: 'differs', at: '/h', ts: 50, rust: -0 }),
    ])
  })

  it('reads a path that draws no line as no place, from the core as from the TypeScript', () => {
    const { core, reports } = fake('differential', () => ({ numbers: [[]] }))
    expect(queryEdgeLabelPlacement(core, [{ x: 5, y: 5 }], { w: 10, h: 10 }, [])).toBeUndefined()
    expect(reports).toEqual([])
  })

  it('sends a fitted height its measurer, mode and floor, and skips a measurer nobody named', () => {
    const { core, asked } = fake('rust', () => ({ numbers: [[42]] }))
    expect(fittedTextNodeHeight(node, { measure, appearance, core })).toBe(42)
    expect(asked).toEqual([
      {
        query: 'node-size',
        node,
        measure: { kind: 'fake', factor: 0.6 },
        mode: 'dark',
        floor: 'ratio',
      },
    ])
    const unnamed = fake('rust', () => ({ numbers: [[42]] }))
    const own = fittedTextNodeHeight(node, { measure: (t, f) => measure(t, f), core: unnamed.core })
    expect(own).not.toBe(42)
    expect(unnamed.reports).toEqual([{ fn: 'layoutQuery', kind: 'skipped', reason: 'measure' }])
  })

  it('skips a natural size handed an option the query does not take', () => {
    const { core, asked, reports } = fake('rust', () => ({ numbers: [[1, 2]] }))
    expect(naturalNodeContentSize(node, { measure, appearance, style: 'document', core })).toEqual({
      w: 1,
      h: 2,
    })
    expect(asked[0]).toEqual({
      query: 'node-content',
      node,
      measure: { kind: 'fake', factor: 0.6 },
      mode: 'dark',
      style: 'document',
    })
    naturalNodeContentSize(node, {
      measure,
      appearance,
      geometry: { paddingPx: 1, labelFontSizePx: 9, minContentWidthPx: 0 },
      core,
    })
    naturalNodeContentSize(node, { measure: (t, f) => measure(t, f), appearance, core })
    naturalNodeContentSize(node, { measure, appearance: { ...appearance }, core })
    expect(reports.map((r) => (r.kind === 'skipped' ? r.reason : r.kind))).toEqual([
      'options',
      'measure',
      'appearance',
    ])
  })

  it('hands an edge layer the canvas request, and its degradations to the caller under rust', () => {
    const canvas = { nodes: [node], edges: [] }
    const event = { kind: 'unknown-theme', theme: 'x.y' } as const
    const { core, asked } = fake('rust', () => ({ nodes: [], degradations: [event] }))
    const degraded: unknown[] = []
    const nodes = layoutSpatialEdges(canvas, {
      measure,
      appearance,
      core,
      onDegrade: (e) => degraded.push(e),
    })
    expect(nodes).toEqual([])
    expect(asked[0]).toMatchObject({ query: 'edges', canvas, mode: 'dark', expand: false })
    expect(degraded).toEqual([event])
  })
})
