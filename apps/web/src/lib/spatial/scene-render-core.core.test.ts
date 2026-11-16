// @vitest-environment node

import type { CanvasLayoutRequest, LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingFragmentTable } from '../fragment-requests.js'
import { currentLayoutCore } from './layout-core.js'
import { editorLayoutBase, renderCanvasToSvgWith } from './scene-render-core.js'

vi.mock('./layout-core.js', () => ({
  currentLayoutCore: vi.fn(),
  layoutCoreReady: vi.fn(),
}))

const measure = constantRatioMeasureText
const canvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'b', x: 300, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

/** A core whose switch says `rust` and whose routing records the layouts it is asked for. */
function recordingCore() {
  const asked: number[] = []
  const core: LayoutCore = {
    routing: {
      routeLayout: (_nodes, edges) => {
        asked.push(edges.length)
        return {
          routes: edges.map((edge) => ({ id: edge.id, kind: 'edge', path: [] })),
          anchors: new Map(),
        } as unknown as ReturnType<LayoutCore['routing']['routeLayout']>
      },
    },
    impl: { routeLayout: 'rust' },
  }
  return { core, asked }
}

describe('the editor layout base', () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('carries the core this realm has loaded', () => {
    const { core } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    expect(editorLayoutBase({ measure }).core).toBe(core)
  })

  it('carries none before one loads, so the layout routes in TypeScript', () => {
    vi.mocked(currentLayoutCore).mockReturnValue(undefined)
    expect(editorLayoutBase({ measure }).core).toBeUndefined()
  })

  it('routes the whole editor render through it', () => {
    const { core, asked } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    renderCanvasToSvgWith(canvas, { measure })
    expect(asked).toEqual([1])
  })
})

describe('the whole layout the editor and its worker hand the core', () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('carries their math and diagram fragments as a table, never a skipped seam', () => {
    const asked: CanvasLayoutRequest[] = []
    const skipped: string[] = []
    vi.mocked(currentLayoutCore).mockReturnValue({
      routing: recordingCore().core.routing,
      layout: {
        layoutSpatialCanvas: (request) => {
          asked.push(request)
          return { declined: 'recording' } as never
        },
      },
      impl: { routeLayout: 'ts', layoutSpatialCanvas: 'differential' },
      onMismatch: (mismatch) => {
        if (mismatch.kind === 'skipped') skipped.push(mismatch.reason)
      },
    })
    const fragment = { svg: '<g/>', width: 4, height: 4 }
    const table = recordingFragmentTable([['math:x^2', fragment]])
    const math = {
      nodes: [
        textNode({
          id: 'm',
          x: 0,
          y: 0,
          width: 200,
          height: 160,
          text: '$$\nx^2\n$$\n\n$$\ny\n$$\n',
        }),
      ],
      edges: [],
    }
    renderCanvasToSvgWith(math, { measure, ...table })
    expect(skipped).toEqual([])
    expect(asked.map((request) => request.fragments)).toEqual([[['math:x^2', fragment]]])
    // The core declined, so the TypeScript drew it and reported what the table lacked.
    expect([...table.asked.values()]).toEqual([{ kind: 'math', value: 'y' }])
  })
})
