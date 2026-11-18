// The one claim about glow that only a rasterizer can check: resvg — the PNG
// export path — actually paints the halo, including beside an AXIS-ALIGNED
// straight edge, whose zero-area bounding box would swallow a bbox-relative
// filter region entirely. Measured on resvg 2.6.2 before the backend was
// written; pinned here so a future resvg or a region regression fails loudly
// instead of exporting an unlit line.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'
import { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'
import { NO_INSTALLED_FONTS } from './test-utils/no-installed-fonts.js'

// Two boxes apart on one row (or one column) with a straight edge between
// them: the edge is axis-aligned, so its own bounding box has no area on one
// axis. Drawn through the core as the export draws it.
const BOX = { width: 120, height: 60, text: '' } as const
const across: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, ...BOX }), textNode({ id: 'b', x: 300, y: 0, ...BOX })],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
}
const down: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, ...BOX }), textNode({ id: 'b', x: 0, y: 200, ...BOX })],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
}

type Axis = 'horizontal' | 'vertical'

interface Raster {
  readonly width: number
  readonly pixels: Buffer
}

const luminance = (r: number, g: number, b: number): number => r + g + b

function pixelAt({ pixels, width }: Raster, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
}

/** The export's SVG of `canvas` in `style`, rasterised by resvg at its own size. */
async function rasterOf(canvas: SpatialCanvas, style: 'document' | 'visual.neon'): Promise<Raster> {
  const { svg } = await renderSpatialCanvasToSvg(canvas, NO_INSTALLED_FONTS, {
    core: testLayoutCore(),
    theme: 'dark',
    style,
  })
  const image = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
  return { width: image.width, pixels: image.pixels }
}

/**
 * Where the edge crosses the raster's middle, and what lies `offset` pixels
 * beside it: the middle column (or row) is between the two boxes, so the
 * brightest pixel along it is the line itself. The ground is the corner's.
 */
function beside(raster: Raster, axis: Axis, offset: number) {
  const height = raster.pixels.length / 4 / raster.width
  const length = axis === 'horizontal' ? height : raster.width
  const at = (along: number): [number, number, number] =>
    axis === 'horizontal'
      ? pixelAt(raster, Math.floor(raster.width / 2), along)
      : pixelAt(raster, along, Math.floor(height / 2))
  let line = 0
  for (let i = 0; i < length; i++) {
    if (luminance(...at(i)) > luminance(...at(line))) line = i
  }
  return {
    ground: pixelAt(raster, 0, 0),
    line: at(line),
    off: at(line - offset),
  }
}

describe('glow under resvg', () => {
  it('paints a halo beside a horizontal edge, several pixels off the line', async () => {
    const { ground, line, off } = beside(await rasterOf(across, 'visual.neon'), 'horizontal', 5)
    expect(luminance(...off) - luminance(...ground)).toBeGreaterThan(20)
    // And the line itself is there, unblurred away.
    expect(luminance(...line)).toBeGreaterThan(luminance(...off))
  })

  it('paints a halo beside a vertical edge, whose box has zero width', async () => {
    const { ground, off } = beside(await rasterOf(down, 'visual.neon'), 'vertical', 5)
    expect(luminance(...off) - luminance(...ground)).toBeGreaterThan(20)
  })

  it('the same edge without glow leaves the ground untouched five pixels off the line', async () => {
    const { ground, off } = beside(await rasterOf(across, 'document'), 'horizontal', 5)
    expect(luminance(...off) - luminance(...ground)).toBeLessThan(4)
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
    const { svg } = await renderSpatialCanvasToSvg(canvas, fonts, {
      core: testLayoutCore(),
      style: 'document',
    })
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
    const png = await renderSpatialCanvasToPng(canvas, fonts, {
      core: testLayoutCore(),
      style: 'document',
      scale,
    })
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
