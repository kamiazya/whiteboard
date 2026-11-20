// The file export's SVG is ONE core call (ADR-0054): the core answers the
// SVG beside the scene, in the envelope the export wants — its padding, the
// palette's paper, the dark mode's text fill and the PNG's raster scale. Every
// render goes through a core that records what it answered, so the envelope is
// judged on the very scene the export drew. That the SVG is the core's backend
// over that scene is held in the core's own tests.

import {
  type CanvasLayoutCore,
  type LayoutCore,
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

// 96 renders, half of them rasterised: 5.5s alone, so more than half of the
// default 10s ceiling before anything else runs. Six busy processes beside it
// (a whole-project run keeps every core busy) took it past 10s and failed it on
// the clock alone; three whole runs on three branches did the same.
const RENDER_GRID_TIMEOUT_MS = 30_000

/** The root's `name` attribute as a number. */
const rootNumber = (svg: string, name: string): number =>
  Number(new RegExp(`^<svg [^>]*?\\b${name}="([^"]*)"`).exec(svg)?.[1])

/** The paper the export draws on, and (dark) the text fill it asks for, are the palette's. */
function expectPaper(
  svg: string,
  canvas: SpatialCanvas,
  options: { theme?: 'light' | 'dark'; style?: SpatialRenderStyle },
  label: string,
): void {
  const mode = options.theme === 'dark' ? 'dark' : 'light'
  const palette = resolveCanvasPalette(canvas, mode, { style: options.style ?? 'clean' })
  expect(svg.startsWith('<svg '), label).toBe(true)
  expect(svg, label).toContain(`fill="${palette.surface}"`)
  if (mode === 'dark' && canvas.nodes.length > 0) expect(svg, label).toContain(palette.labelFill)
}

describe('the file export in one core call', () => {
  it(
    'draws the SVG and the PNG source from the one scene the core answered',
    async () => {
      const { core, answered } = recordingCore()
      let compared = 0
      const marks = new Set<string>()
      const widths = new Map<string, number>()
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
              expectPaper(one.svg, canvas, options, label)
              widths.set(`${label}`, rootNumber(one.svg, 'width'))
              for (const mark of ['calls', 'data-wb-legend', 'wb-glow']) {
                if (one.svg.includes(mark)) marks.add(mark)
              }
              await renderSpatialCanvasToPng(canvas, NO_INSTALLED_FONTS, { ...options, scale: 3 })
              const zoomed = answered.at(-1) as Answered
              expect(zoomed === one, label).toBe(false)
              expectPaper(zoomed.svg, canvas, options, label)
              compared += 2
            }
          }
        }
      }
      expect(compared).toBe(96)
      // Padding grows the picture by its width on both sides.
      for (const canvas of ['3', '0']) {
        for (const theme of ['light', 'dark']) {
          for (const style of [undefined, 'document', 'visual.sketch', 'visual.neon']) {
            const at = (padding: number | undefined) =>
              widths.get(`${canvas} ${theme} ${style} ${padding}`) as number
            expect(at(24) - at(0), `${canvas} ${theme} ${style}`).toBe(48)
            expect(at(undefined) - at(0), `${canvas} ${theme} ${style}`).toBe(
              2 * DEFAULT_PADDING_PX,
            )
          }
        }
      }
      // The board reaches what the export draws: an edge label, a legend and a theme's glow.
      expect([...marks].sort()).toEqual(['calls', 'data-wb-legend', 'wb-glow'])
    },
    RENDER_GRID_TIMEOUT_MS,
  )

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
  })
})
