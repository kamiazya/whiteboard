// @vitest-environment node

import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
