import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { QueryAnswer, QueryRequest } from '../query-core.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_THEME_GEOMETRY } from '../theme/spatial-geometry.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { CoreUnaskable } from './canvas-switch.js'
import { fittedTextNodeHeight } from './fitted-height.js'
import {
  queryCommentBubble,
  queryEdgeLabelPlacement,
  queryLabelObstacles,
  queryOutlineContentBox,
} from './queries.js'
import { layoutSpatialEdges, naturalNodeContentSize } from './spatial-canvas.js'

/** A core whose query entry answers `answer`, recording what it was asked. */
function fake(answer: (request: QueryRequest) => QueryAnswer) {
  const asked: QueryRequest[] = []
  const core = fakeLayoutCore({
    query: {
      layoutQuery: (request) => {
        asked.push(request)
        return answer(request)
      },
    },
  })
  return { core, asked }
}

const box = { x: 0, y: 0, w: 100, h: 50 }
const node = textNode({ id: 'n', x: 0, y: 0, width: 160, height: 80, text: 'two words' })
const measure = createFakeMeasure()
const appearance = createSpatialTheme({ mode: 'dark' })
const refused = () => ({ refused: { code: 'malformed', reason: 'non-finite' } }) as const

describe('the queries through the core', () => {
  it('answers with the TypeScript when handed no core, and with the core when handed one', () => {
    expect(queryOutlineContentBox(undefined, undefined, box)).toEqual(box)
    const rust = fake(() => ({ numbers: [[1, 2, 3, 4]] }))
    expect(queryOutlineContentBox(rust.core, 'visual.ellipse', box)).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    })
    expect(rust.asked).toEqual([
      { query: 'outline-content-box', shape: 'visual.ellipse', box: [0, 0, 100, 50] },
    ])
  })

  it('throws what the core throws, and an answer in another shape', () => {
    const err = new Error('trap')
    const thrown = fake(() => {
      throw err
    })
    expect(() => queryOutlineContentBox(thrown.core, undefined, box)).toThrow(err)
    const shaped = fake(() => ({ numbers: [[1, 2, 3]] }))
    expect(() => queryOutlineContentBox(shaped.core, undefined, box)).toThrow(/another shape/)
  })

  it('answers a refused query with the plainest geometry that keeps the editor usable', () => {
    const { core } = fake(refused)
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(queryOutlineContentBox(core, 'visual.ellipse', box)).toBe(box)
    expect(queryEdgeLabelPlacement(core, path, { w: 10, h: 10 }, [])).toBeUndefined()
    expect(queryLabelObstacles(core, [node], [])).toEqual({ titles: [], obstacles: [] })
    expect(queryCommentBubble(core, { x: 5, y: 7 }, { w: 20, h: 10 }, [])).toEqual({
      x: 5,
      y: 7,
      w: 20,
      h: 10,
    })
    expect(fittedTextNodeHeight(node, { measure, appearance, core })).toBe(node.height)
    const inset = 2 * SPATIAL_THEME_GEOMETRY.paddingPx
    expect(naturalNodeContentSize(node, { measure, appearance, core })).toEqual({
      w: node.width - inset,
      h: node.height - inset,
    })
    const canvas = { nodes: [node], edges: [] }
    expect(layoutSpatialEdges(canvas, { measure, appearance, core })).toEqual([])
  })

  it('reads a path that draws no line as no place', () => {
    const { core } = fake(() => ({ numbers: [[]] }))
    expect(queryEdgeLabelPlacement(core, [{ x: 5, y: 5 }], { w: 10, h: 10 }, [])).toBeUndefined()
  })

  it('sends a fitted height its measurer, mode and floor, and throws for a measurer nobody named', () => {
    const { core, asked } = fake(() => ({ numbers: [[42]] }))
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
    expect(() =>
      fittedTextNodeHeight(node, { measure: (t, f) => measure(t, f), core: fake(refused).core }),
    ).toThrow(new CoreUnaskable('measure'))
  })

  it('throws for a natural size handed an option the query does not take', () => {
    const { core, asked } = fake(() => ({ numbers: [[1, 2]] }))
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
    const geometry = { paddingPx: 1, labelFontSizePx: 9, minContentWidthPx: 0 }
    expect(() => naturalNodeContentSize(node, { measure, appearance, geometry, core })).toThrow(
      new CoreUnaskable('option:geometry'),
    )
    expect(() =>
      naturalNodeContentSize(node, { measure: (t, f) => measure(t, f), appearance, core }),
    ).toThrow(new CoreUnaskable('measure'))
    expect(() =>
      naturalNodeContentSize(node, { measure, appearance: { ...appearance }, core }),
    ).toThrow(new CoreUnaskable('appearance'))
    expect(asked).toHaveLength(1)
  })

  it('hands an edge layer the canvas request, and its degradations to the caller', () => {
    const canvas = { nodes: [node], edges: [] }
    const event = { kind: 'unknown-theme', theme: 'x.y' } as const
    const { core, asked } = fake(() => ({ nodes: [], degradations: [event] }))
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
