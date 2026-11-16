// @vitest-environment node

import type { CanvasLayoutRequest } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
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

/** A core recording the layouts it is asked for, each answered with an empty scene. */
function recordingCore() {
  const asked: CanvasLayoutRequest[] = []
  const core = fakeLayoutCore({
    layout: {
      layoutSpatialCanvas: (request) => {
        asked.push(request)
        return { scene: { nodes: [] }, anchors: new Map(), degradations: [] }
      },
    },
  })
  return { core, asked }
}

describe('the editor layout base', () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('carries the core this realm has loaded', () => {
    const { core } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    expect(editorLayoutBase({ measure }).core).toBe(core)
  })

  it('throws, naming the realm, where no core is loaded: nothing lays out in its place', () => {
    vi.mocked(currentLayoutCore).mockReturnValue(undefined)
    expect(() => editorLayoutBase({ measure })).toThrow(/the layout core is not loaded/)
  })

  it('lays the whole editor render out through it', () => {
    const { core, asked } = recordingCore()
    vi.mocked(currentLayoutCore).mockReturnValue(core)
    renderCanvasToSvgWith(canvas, { measure })
    expect(asked.map((request) => request.canvas)).toEqual([canvas])
  })
})

describe('the whole layout the editor and its worker hand the core', () => {
  beforeEach(() => vi.mocked(currentLayoutCore).mockReset())

  it('carries their math and diagram fragments as a table, never a seam no request carries', () => {
    const asked: CanvasLayoutRequest[] = []
    vi.mocked(currentLayoutCore).mockReturnValue(
      fakeLayoutCore({
        layout: {
          layoutSpatialCanvas: (request) => {
            asked.push(request)
            return {
              scene: { nodes: [] },
              anchors: new Map(),
              degradations: [],
              fragmentsAsked: [{ kind: 'math', value: 'y' }],
            }
          },
        },
      }),
    )
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
    // A seam set as a function would throw `CoreUnaskable` here.
    renderCanvasToSvgWith(math, { measure, ...table })
    expect(asked.map((request) => request.fragments)).toEqual([[['math:x^2', fragment]]])
    // What the core reported the table lacked reaches the table.
    expect([...table.asked.values()]).toEqual([{ kind: 'math', value: 'y' }])
  })
})
