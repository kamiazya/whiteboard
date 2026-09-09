// The one claim about glow that only a rasterizer can check: resvg — the PNG
// export path — actually paints the halo, including beside an AXIS-ALIGNED
// straight edge, whose zero-area bounding box would swallow a bbox-relative
// filter region entirely. Measured on resvg 2.6.2 before the backend was
// written; pinned here so a future resvg or a region regression fails loudly
// instead of exporting an unlit line.
import { renderSceneToSvg, type Scene } from '@kamiazya/whiteboard-canvas-render'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it } from 'vitest'

const BACKGROUND = '#030711'

const scene: Scene = {
  nodes: [
    {
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
    },
  ],
}

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

  it('the same edge without glow leaves the ground untouched five pixels off the line', () => {
    const { glow: _glow, ...plain } =
      scene.nodes[0]!.kind === 'edge' ? scene.nodes[0].appearance! : {}
    const crisp: Scene = { nodes: [{ ...(scene.nodes[0] as never), appearance: plain }] }
    const svg = renderSceneToSvg(crisp, { width: 240, height: 120, background: BACKGROUND })
    const image = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
    const [r] = pixelAt(image.pixels, image.width, 120, 60 - 5)
    expect(r).toBeLessThan(0x03 + 4)
  })
})
