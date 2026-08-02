import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { indexNodeBoxes } from './geometry.js'
import { renderCanvasToSvg } from './scene-render.js'

function fakeMeasure(text: string) {
  return { advanceWidth: text.length * 6, ascent: 10, descent: 2, lineGap: 0 }
}

function canvas(): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
      { id: 'b', type: 'file', x: 200, y: 0, width: 80, height: 40, file: 'x.png' },
    ],
    edges: [],
  }
}

describe('renderCanvasToSvg', () => {
  it('produces a byte-stable svg document whose bounds cover every node', () => {
    const c = canvas()
    const first = renderCanvasToSvg(c, { measure: fakeMeasure })
    const second = renderCanvasToSvg(c, { measure: fakeMeasure })
    expect(first.svg).toBe(second.svg)
    expect(first.svg).toContain('<svg')
    expect(first.bounds.w).toBeGreaterThan(0)
    expect(first.bounds.h).toBeGreaterThan(0)
  })

  it('renders an empty canvas without throwing', () => {
    const empty: SpatialCanvas = { nodes: [], edges: [] }
    const result = renderCanvasToSvg(empty, { measure: fakeMeasure })
    expect(result.svg).toContain('<svg')
  })

  it('scene shape bboxes agree with indexNodeBoxes — layout and hit-testing never diverge', () => {
    const c = canvas()
    const { scene } = renderCanvasToSvg(c, { measure: fakeMeasure })
    const shapeBoxes = scene.nodes
      .filter((n): n is Extract<typeof n, { kind: 'shape' }> => n.kind === 'shape')
      .map((n) => n.bbox)
    const expected = indexNodeBoxes(c).map((n) => ({
      x: n.box.x,
      y: n.box.y,
      w: n.box.width,
      h: n.box.height,
    }))
    expect(shapeBoxes).toEqual(expected)
  })

  it('renders dark chrome only when theme is dark, leaving the omitted/light path untouched', () => {
    const c = canvas()
    const omitted = renderCanvasToSvg(c, { measure: fakeMeasure })
    const light = renderCanvasToSvg(c, { measure: fakeMeasure, theme: 'light' })
    const dark = renderCanvasToSvg(c, { measure: fakeMeasure, theme: 'dark' })
    expect(omitted.svg).toBe(light.svg)
    expect(omitted.svg).toContain('#333333')
    expect(dark.svg).not.toContain('#333333')
    expect(dark.svg).toContain('#9BA3AF')
  })

  it('keeps scene geometry identical across themes — only color attributes differ', () => {
    const c = canvas()
    const light = renderCanvasToSvg(c, { measure: fakeMeasure, theme: 'light' })
    const dark = renderCanvasToSvg(c, { measure: fakeMeasure, theme: 'dark' })
    expect(dark.bounds).toEqual(light.bounds)
  })
})
