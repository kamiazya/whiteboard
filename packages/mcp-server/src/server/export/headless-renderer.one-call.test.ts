// The file export's SVG is ONE core call (ADR-0054): the core answers the
// SVG beside the scene, and the bytes are the ones the TypeScript backend
// draws of that scene in the envelope the export always used — its padding,
// the palette's paper, the dark mode's text fill and the PNG's raster scale.
// Every render goes through a core that records what it answered, so the old
// expression is judged on the very scene the export drew.

import {
  type CanvasLayoutCore,
  type LayoutCore,
  renderSceneToSvg,
  resolveCanvasPalette,
  type Scene,
  type SpatialRenderStyle,
} from '@kamiazya/whiteboard-canvas-render'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'
import { NO_INSTALLED_FONTS } from './test-utils/no-installed-fonts.js'

interface Answered {
  readonly scene: Scene
  readonly svg: string
}

/** The test core, recording each SVG it answered with the scene beside it. */
function recordingCore(): { core: LayoutCore; answered: Answered[] } {
  const real = testLayoutCore()
  const answered: Answered[] = []
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas: (...args) => {
      const answer = real.layout.layoutSpatialCanvas(...args)
      if ('svg' in answer && answer.svg !== undefined) {
        answered.push({ scene: answer.scene, svg: answer.svg })
      }
      return answer
    },
  }
  return { core: { ...real, layout }, answered }
}

const BOARD: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g', x: 0, y: 0, width: 520, height: 260, label: 'Area' }),
    textNode({ id: 'a', x: 40, y: 40, width: 180, height: 90, text: '**bold** `code`' }),
    textNode({ id: 'b', x: 300, y: 60, width: 160, height: 60, text: 'b', tags: ['h:ok'] }),
  ],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: 'calls' }],
}

const LIBRARY: TagLibrary = { h: { values: { ok: { color: '4' } } } }

const DEFAULT_PADDING_PX = 10

/** What the export drew before: the backend over the scene, in the export's envelope. */
function exportedBefore(
  scene: Scene,
  canvas: SpatialCanvas,
  options: { theme?: 'light' | 'dark'; style?: SpatialRenderStyle; padding?: number },
  rasterScale: number,
): string {
  const mode = options.theme === 'dark' ? 'dark' : 'light'
  const palette = resolveCanvasPalette(canvas, mode, { style: options.style ?? 'clean' })
  return renderSceneToSvg(scene, {
    padding: options.padding ?? DEFAULT_PADDING_PX,
    background: palette.surface,
    rasterScale,
    ...(mode === 'dark' ? { textFill: palette.labelFill } : {}),
  })
}

describe('the file export in one core call', () => {
  it('draws the SVG and the PNG source the backend drew of the same scene', async () => {
    const { core, answered } = recordingCore()
    let compared = 0
    const marks = new Set<string>()
    for (const canvas of [BOARD, { nodes: [], edges: [] }]) {
      for (const theme of ['light', 'dark'] as const) {
        for (const style of [undefined, 'document', 'visual.sketch', 'visual.neon'] as const) {
          for (const padding of [undefined, 0, 24]) {
            const options = {
              core,
              theme,
              tagLibrary: LIBRARY,
              ...(style === undefined ? {} : { style }),
              ...(padding === undefined ? {} : { padding }),
            }
            const label = `${canvas.nodes.length} ${theme} ${style} ${padding}`
            const svg = await renderSpatialCanvasToSvg(canvas, NO_INSTALLED_FONTS, options)
            const one = answered.at(-1) as Answered
            expect(svg.svg === one.svg, label).toBe(true)
            expect(one.svg === exportedBefore(one.scene, canvas, options, 1), label).toBe(true)
            for (const mark of ['calls', 'data-wb-legend', 'wb-glow']) {
              if (one.svg.includes(mark)) marks.add(mark)
            }
            await renderSpatialCanvasToPng(canvas, NO_INSTALLED_FONTS, { ...options, scale: 3 })
            const zoomed = answered.at(-1) as Answered
            expect(zoomed === one, label).toBe(false)
            expect(zoomed.svg === exportedBefore(zoomed.scene, canvas, options, 3), label).toBe(
              true,
            )
            compared += 2
          }
        }
      }
    }
    expect(compared).toBe(96)
    // The board reaches what the export draws: an edge label, a legend and a theme's glow.
    expect([...marks].sort()).toEqual(['calls', 'data-wb-legend', 'wb-glow'])
  })

  it('budgets the filters at the zoom the PNG is drawn at', async () => {
    const { core, answered } = recordingCore()
    const big = {
      nodes: [textNode({ id: 'n', x: 0, y: 0, width: 1600, height: 1600, text: '' })],
      edges: [],
    }
    const options = { core, style: 'visual.neon' as const }
    await renderSpatialCanvasToSvg(big, NO_INSTALLED_FONTS, options)
    const one = answered.at(-1) as Answered
    await renderSpatialCanvasToPng(big, NO_INSTALLED_FONTS, { ...options, scale: 3 })
    const zoomed = answered.at(-1) as Answered
    // The glow fits the budget at scale 1 and not at three times it.
    expect(one.svg).toContain('filter=')
    expect(zoomed.svg).not.toContain('filter=')
    expect(zoomed.svg === exportedBefore(zoomed.scene, big, options, 3)).toBe(true)
  })
})
