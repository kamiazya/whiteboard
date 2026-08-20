// Two separate claims, deliberately not tested together:
//
//   1. `withViewerFontEmbedded` puts the viewer's family and a data: URI into
//      the SVG. Pure string work.
//   2. A data: URI face reaches an `<img>`-rendered SVG at all — the platform
//      fact the whole thing rests on, and the one a `FontFace` on the document
//      does NOT satisfy.
//
// (2) is asserted under a family name NOBODY can have. Asserting it as
// "Roboto" would be vacuous on any machine with Roboto installed — which is
// most of them, and is exactly what made the first hand-measurement of this
// look like the FontFace had crossed when it had not.

import { beforeEach, describe, expect, it } from 'vitest'
import { VIEWER_FONT_FAMILY } from './font.js'
import {
  _resetViewerFontEmbeddingForTests,
  viewerFontDataUri,
  withViewerFontEmbedded,
} from './font-embedding.js'

beforeEach(() => {
  _resetViewerFontEmbeddingForTests()
})

const TEXT = 'Hamburgefonstiv Hamburgefonstiv'

function svgNaming(family: string, faceCss = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="90">${faceCss}<rect width="900" height="90" fill="#ffffff"/><text x="5" y="60" font-family="${family}" font-size="44" fill="#000000">${TEXT}</text></svg>`
}

/** Ink bounding box of an SVG rasterised the way a PNG export rasterises one. */
async function rasterisedInk(svg: string): Promise<{ width: number; height: number }> {
  const canvas = document.createElement('canvas')
  canvas.width = 900
  canvas.height = 90
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('no 2d context')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 900, 90)

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('failed to load SVG'))
      img.src = url
    })
    ctx.drawImage(image, 0, 0)
  } finally {
    URL.revokeObjectURL(url)
  }

  const { data } = ctx.getImageData(0, 0, 900, 90)
  let minX = 900
  let maxX = -1
  let minY = 90
  let maxY = -1
  for (let y = 0; y < 90; y++) {
    for (let x = 0; x < 900; x++) {
      if (data[(y * 900 + x) * 4]! < 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { width: maxX - minX, height: maxY - minY }
}

describe('withViewerFontEmbedded', () => {
  it('carries the viewer family and the face bytes into the document', async () => {
    const embedded = await withViewerFontEmbedded(svgNaming(VIEWER_FONT_FAMILY))

    expect(embedded).toContain('@font-face')
    expect(embedded).toContain(`font-family:'${VIEWER_FONT_FAMILY}'`)
    expect(embedded).toContain('data:font/ttf;base64,')
    // Inserted INSIDE the root element, or the rule governs nothing.
    expect(embedded.indexOf('@font-face')).toBeGreaterThan(embedded.indexOf('<svg'))
    expect(embedded.indexOf('@font-face')).toBeLessThan(embedded.indexOf('<text'))
  })

  it('leaves the drawing untouched', async () => {
    const original = svgNaming(VIEWER_FONT_FAMILY)
    const embedded = await withViewerFontEmbedded(original)

    // Everything the original said is still said, in order — the transform
    // adds, it does not rewrite.
    expect(embedded).toContain('<rect width="900" height="90" fill="#ffffff"/>')
    expect(embedded).toContain(`font-family="${VIEWER_FONT_FAMILY}"`)
  })
})

describe('a data: URI face reaches a rasterised SVG', () => {
  // The claim `ensureViewerFontLoaded` cannot make. Under a family no system
  // font can match, so "it drew differently" has exactly one explanation.
  const UNCLAIMABLE = 'WhiteboardEmbedProbeZzz'

  it('changes what an <img>-rendered SVG draws, where a registered FontFace does not', async () => {
    const dataUri = await viewerFontDataUri()
    expect(dataUri).not.toBeNull()

    const withoutFace = await rasterisedInk(svgNaming(UNCLAIMABLE))
    const withFace = await rasterisedInk(
      svgNaming(
        UNCLAIMABLE,
        `<defs><style>@font-face{font-family:'${UNCLAIMABLE}';src:url('${dataUri}') format('truetype');}</style></defs>`,
      ),
    )

    // Something was drawn at all — otherwise both are empty and equal, and
    // this test would pass while asserting nothing.
    expect(withoutFace.width).toBeGreaterThan(0)
    expect(withFace.width).toBeGreaterThan(0)
    // Different metrics: the fallback the browser picked for an unknown family
    // is not the face we handed it.
    expect(withFace.width).not.toBe(withoutFace.width)
  })

  it('proves the same registration through document.fonts does NOT', async () => {
    const dataUri = await viewerFontDataUri()
    const family = 'WhiteboardFontFaceProbeZzz'
    const face = new FontFace(family, `url(${dataUri})`)
    await face.load()
    document.fonts.add(face)
    expect(face.status).toBe('loaded')

    // Loaded, on this document, and the rasteriser still cannot see it: an
    // `<img>`-rendered SVG is a separate resource-restricted document. This is
    // the whole reason `font-embedding.ts` exists rather than reusing
    // `ensureViewerFontLoaded`.
    const viaFontFace = await rasterisedInk(svgNaming(family))
    const unknownFamily = await rasterisedInk(svgNaming('WhiteboardNothingHasThisNameZzz'))
    expect(viaFontFace.width).toBe(unknownFamily.width)
    expect(viaFontFace.height).toBe(unknownFamily.height)
  })
})
