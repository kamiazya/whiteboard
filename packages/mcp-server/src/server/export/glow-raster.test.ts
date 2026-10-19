// The one claim about glow that only a rasterizer can check: resvg — the PNG
// export path — actually paints the halo, including beside an AXIS-ALIGNED
// straight edge, whose zero-area bounding box would swallow a bbox-relative
// filter region entirely. Measured on resvg 2.6.2 before the backend was
// written; pinned here so a future resvg or a region regression fails loudly
// instead of exporting an unlit line.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSceneToSvg, type Scene } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'

const BACKGROUND = '#030711'

type SceneEdge = Extract<Scene['nodes'][number], { kind: 'edge' }>

const edge: SceneEdge = {
  kind: 'edge',
  id: 'e',
  path: [
    { x: 20, y: 60 },
    { x: 220, y: 60 },
  ],
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'none',
  appearance: { stroke: '#f472b6', strokeWidth: 2, glow: { radiusPx: 6 } },
}
const scene: Scene = { nodes: [edge] }

function pixelAt(pixels: Buffer, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
}

describe('glow under resvg', () => {
  it('paints a halo beside a horizontal edge, several pixels off the line', () => {
    const svg = renderSceneToSvg(scene, { width: 240, height: 120, background: BACKGROUND })
    const image = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
    const [r, g, b] = pixelAt(image.pixels, image.width, 120, 60 - 5)
    const [bgR, bgG, bgB] = [0x03, 0x07, 0x11]
    // Pink halo: red channel well above the near-black ground.
    expect(r - bgR).toBeGreaterThan(20)
    expect(g).toBeGreaterThanOrEqual(bgG)
    expect(b).toBeGreaterThanOrEqual(bgB)
    // And the line itself is there, unblurred away.
    const [lr] = pixelAt(image.pixels, image.width, 120, 60)
    expect(lr).toBeGreaterThan(200)
  })

  it('paints a halo beside a vertical edge, whose box has zero width', () => {
    const vertical: Scene = {
      nodes: [
        {
          ...edge,
          path: [
            { x: 120, y: 10 },
            { x: 120, y: 110 },
          ],
        },
      ],
    }
    const svg = renderSceneToSvg(vertical, { width: 240, height: 120, background: BACKGROUND })
    const image = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
    const [r] = pixelAt(image.pixels, image.width, 120 - 5, 60)
    expect(r - 0x03).toBeGreaterThan(20)
  })

  it('the same edge without glow leaves the ground untouched five pixels off the line', () => {
    const { glow: _glow, ...plain } = edge.appearance ?? {}
    const crisp: Scene = { nodes: [{ ...edge, appearance: plain }] }
    const svg = renderSceneToSvg(crisp, { width: 240, height: 120, background: BACKGROUND })
    const image = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
    const [r] = pixelAt(image.pixels, image.width, 120, 60 - 5)
    expect(r).toBeLessThan(0x03 + 4)
  })
})

/** Decodes a PNG by drawing it through resvg as a `data:` image. */
function decode(png: Buffer, width: number, height: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`
  return new Resvg(svg).render().pixels
}

describe('glow under the export filter budget', () => {
  // Two boxes a whole board apart, so the edge between them glows over a
  // region of about 2.3M pixels: inside the budget at 1x, four times it at 2x.
  const canvas: SpatialCanvas = {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'a' }),
      textNode({ id: 'b', x: 1500, y: 1500, width: 100, height: 60, text: 'b' }),
    ],
    edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
    facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
  }
  const fonts = join(tmpdir(), 'whiteboard-test-no-installed-fonts')

  /** Red above the ground, six user units off the middle of the edge's longest segment. */
  async function haloAt(scale: number): Promise<number> {
    const { svg } = await renderSpatialCanvasToSvg(canvas, fonts, { style: 'document' })
    const [vx, vy] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number)
    const points = /<polyline points="([^"]+)"/
      .exec(svg)![1]!
      .split(' ')
      .map((pair) => pair.split(',').map(Number) as [number, number])
    const segments = points.slice(1).map((end, i) => [points[i]!, end] as const)
    const [[x0, y0], [x1, y1]] = segments.reduce((a, b) =>
      Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) >
      Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1])
        ? b
        : a,
    )
    const horizontal = y0 === y1
    const ux = (x0 + x1) / 2 + (horizontal ? 0 : 6)
    const uy = (y0 + y1) / 2 + (horizontal ? 6 : 0)
    const png = await renderSpatialCanvasToPng(canvas, fonts, { style: 'document', scale })
    const pixels = decode(png.png, png.width, png.height)
    const at = (x: number, y: number) => {
      const i = (Math.round((y - vy!) * scale) * png.width + Math.round((x - vx!) * scale)) * 4
      return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
    }
    const ground = at(vx!, vy!)
    const halo = at(ux, uy)
    return Math.max(...halo.map((channel, c) => Math.abs(channel - ground[c]!)))
  }

  it('keeps a long edge glowing at 1x and drops its halo at 2x', async () => {
    expect(await haloAt(1)).toBeGreaterThan(10)
    expect(await haloAt(2)).toBe(0)
  })
})
