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

  // A family name is spliced into a CSS string inside XML text, so a quote
  // ends the CSS string and a `<` or `&` ends or corrupts the XML. Such a
  // face is left out — the export falls back to a system face — while the
  // others still travel.
  it.each([
    ['a single quote', "a'b"],
    ['a double quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['a closing style tag', 'a</style><script>x</script>'],
    ['an ampersand', 'a&amp;b'],
    ['a greater-than sign', 'a>b'],
    ['a newline', 'a\nb'],
    ['a NUL', 'a\u0000b'],
    ['a DEL', 'a\u007fb'],
  ])('leaves out a face whose family name carries %s', async (_label, family) => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
    const out = await withViewerFontEmbedded('<svg xmlns="http://www.w3.org/2000/svg"></svg>', [
      { family, bytes: new Uint8Array([7]).buffer },
      { family: 'Yomogi', bytes: new Uint8Array([1]).buffer },
    ])
    expect(out).not.toContain(family)
    expect(out).not.toContain(fontBytesToDataUri(new Uint8Array([7]).buffer))
    expect(out).toContain("font-family:'Yomogi'")
    const doc = new DOMParser().parseFromString(out, 'image/svg+xml')
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
  })

  it('still embeds a family name with spaces, digits and non-ASCII letters', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
    const out = await withViewerFontEmbedded('<svg xmlns="x"></svg>', [
      { family: 'Noto Sans JP 2-Bold 源ノ角', bytes: new Uint8Array([1]).buffer },
    ])
    expect(out).toContain("font-family:'Noto Sans JP 2-Bold 源ノ角'")
  })

  // The <img> a PNG export draws through is an XML parser: one byte lost at
  // the splice and the export is a broken image rather than a drawing with
  // the wrong face, so the output is read the way that parser reads it.
  it('splices the faces in as a well-formed first child of the root', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])))
    const head = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 9 9">'
    const drawing = '<text font-family="Roboto">a</text></svg>'
    const out = await withViewerFontEmbedded(head + drawing)

    const doc = new DOMParser().parseFromString(out, 'image/svg+xml')
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    const root = doc.documentElement
    expect(root.getAttribute('viewBox')).toBe('0 0 9 9')
    expect(root.firstElementChild?.tagName).toBe('defs')
    expect(root.firstElementChild?.firstElementChild?.tagName).toBe('style')
    // Only inserted: the root's own tag and the drawing are byte for byte.
    expect(out.startsWith(`${head}<defs>`)).toBe(true)
    expect(out.slice(out.indexOf('</defs>') + '</defs>'.length)).toBe(drawing)
  })
})
