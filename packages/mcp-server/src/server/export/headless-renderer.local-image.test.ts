// A markdown image is written by whoever can edit the document, and the PNG
// export rasterises it on the daemon. resvg resolves an `<image href>` that is
// not a `data:` URI by reading it from the daemon's own filesystem, so a body
// naming a host path would draw a host file into the export — or, naming a
// device such as `/dev/zero`, read without bound on the serving loop.
//
// The picture is checked in pixels, not only in the SVG: what matters is what
// resvg actually drew.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Resvg } from '@resvg/resvg-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } from './headless-renderer.js'

const redPng = (): Buffer =>
  Buffer.from(
    new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ff0000"/></svg>',
    )
      .render()
      .asPng(),
  )

/** Decodes a PNG by drawing it through resvg as a `data:` image, the one href kind it is still given. */
const redPixels = (png: Buffer, width: number, height: number): number => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`
  const { pixels } = new Resvg(svg).render()
  let count = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i]! > 200 && pixels[i + 1]! < 60 && pixels[i + 2]! < 60) count += 1
  }
  return count
}

const canvasNaming = (url: string): SpatialCanvas => ({
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 240, height: 240, text: `![x](${url})` })],
  edges: [],
})

describe('a markdown image naming a path on the daemon host', () => {
  let dir: string
  let imagePath: string
  let fontsDir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-export-local-image-'))
    imagePath = join(dir, 'red.png')
    writeFileSync(imagePath, redPng())
    fontsDir = join(dir, 'fonts')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the decoder sees red when red is embedded as data', () => {
    const png = redPng()
    expect(redPixels(png, 64, 64)).toBeGreaterThan(1000)
  })

  it('is not drawn into the PNG export', async () => {
    const result = await renderSpatialCanvasToPng(canvasNaming(imagePath), fontsDir)
    expect(redPixels(result.png, result.width, result.height)).toBe(0)
  })

  // A `data:` URI is let through, so a nested SVG naming the host path is the
  // way round the guard. resvg loads a nested SVG with none of its own images
  // (it does draw the nested SVG's shapes); this pins that upstream behaviour.
  it('is not drawn when named from inside a data: SVG', async () => {
    const nested = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image width="64" height="64" href="${imagePath}"/></svg>`,
    ).toString('base64')
    const result = await renderSpatialCanvasToPng(
      canvasNaming(`data:image/svg+xml;base64,${nested}`),
      fontsDir,
    )
    expect(redPixels(result.png, result.width, result.height)).toBe(0)
  })

  it('is not emitted as an image href in the SVG export', async () => {
    const { svg } = await renderSpatialCanvasToSvg(canvasNaming(imagePath), fontsDir)
    expect(svg).not.toContain('<image href="/')
    expect(svg).not.toContain(imagePath)
  })
})
