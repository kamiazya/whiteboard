// A PNG export rasterises the SVG inside an <img>, where a registered face
// is invisible; a face the host holds as bytes travels inside the document
// the same way the vendored one does — and only the faces the caller names.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetViewerFontEmbeddingForTests,
  fontBytesToDataUri,
  withViewerFontEmbedded,
} from './font-embedding.js'

describe('withViewerFontEmbedded with host-held faces', () => {
  afterEach(() => {
    _resetViewerFontEmbeddingForTests()
    vi.unstubAllGlobals()
  })

  it('embeds each extra face as a data: rule beside the vendored one', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
    const out = await withViewerFontEmbedded(
      '<svg xmlns="x"><text font-family="Yomogi">a</text></svg>',
      [{ family: 'Yomogi', bytes: new Uint8Array([9, 8]).buffer }],
    )
    expect(out).toContain("font-family:'Roboto';src:url('data:font/ttf;base64,")
    expect(out).toContain(
      `font-family:'Yomogi';src:url('${fontBytesToDataUri(new Uint8Array([9, 8]).buffer)}')`,
    )
    expect(out.indexOf('<defs>')).toBeLessThan(out.indexOf('<text'))
  })

  it('still carries the extra faces when the vendored one cannot be read', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const out = await withViewerFontEmbedded('<svg xmlns="x"></svg>', [
      { family: 'Yomogi', bytes: new Uint8Array([1]).buffer },
    ])
    expect(out).toContain("font-family:'Yomogi'")
    expect(out).not.toContain("font-family:'Roboto'")
  })
})
