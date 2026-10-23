// The saved file outside a real browser: which page-local pictures are
// written in as pixels and which are left out, and what the PNG path hands
// the rasteriser and embeds. jsdom has no image decoder and no 2D context, so
// both are stubbed per test; the real-pixel half is document-export.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { savedPicture } from './document-export.js'
import { extractTextFromPng } from './png-embed.js'
import { rasterizeSvgToPng } from './rasterize-svg.js'

vi.mock('./rasterize-svg.js', () => ({ rasterizeSvgToPng: vi.fn() }))

/** The smallest stream `embedTextInPng` reads as a PNG: signature, then IEND. */
const BARE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
])

/** What the stubbed decoder knows of each URL: its size, or that it fails. */
type Decoded = { width: number; height: number } | 'fails'

function stubDecoder(pictures: Record<string, Decoded>, dataUri = 'data:image/png;base64,AAAA') {
  const decoded: string[] = []
  // jsdom implements no `decode` at all, so it is defined here and removed after.
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value(this: HTMLImageElement) {
      const url = this.getAttribute('src') ?? ''
      decoded.push(url)
      const picture = pictures[url]
      if (picture === undefined || picture === 'fails') return Promise.reject(new Error('no'))
      Object.defineProperty(this, 'naturalWidth', { value: picture.width })
      Object.defineProperty(this, 'naturalHeight', { value: picture.height })
      return Promise.resolve()
    },
  })
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => dataUri)
  return { decoded, drawImage }
}

const drawnWith = (svg: string, w = 4, h = 3) => ({ svg, bounds: { x: 0, y: 0, w, h } })
const image = (href: string) => `<image x="0" y="0" width="4" height="3" href="${href}"/>`
const svgOf = (...children: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3">${children.join('')}</svg>`

beforeEach(() => {
  // The vendored face is fetched for the PNG path; refusing it keeps the run offline.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
})

const nativeDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')

afterEach(() => {
  if (nativeDecode === undefined) Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
  else Object.defineProperty(HTMLImageElement.prototype, 'decode', nativeDecode)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(rasterizeSvgToPng).mockReset()
})

describe('savedPicture, resolution', () => {
  it('hands the rasteriser the scale, and 1x when none is asked for', async () => {
    vi.mocked(rasterizeSvgToPng).mockResolvedValue(null)
    await savedPicture('png', drawnWith(svgOf()))
    await savedPicture('png', { ...drawnWith(svgOf()), scale: 2 })
    expect(vi.mocked(rasterizeSvgToPng).mock.calls.map((call) => call[3])).toEqual([1, 2])
  })

  it('writes an SVG the same at either scale', async () => {
    const svg = svgOf()
    const at2 = await savedPicture('svg', { ...drawnWith(svg), scale: 2 })
    expect(await at2?.text()).toBe(svg)
    expect(rasterizeSvgToPng).not.toHaveBeenCalled()
  })
})

describe('savedPicture, page-local pictures', () => {
  it('writes an SVG naming no page-local picture through unchanged', async () => {
    const { decoded } = stubDecoder({})
    const svg = svgOf(image('https://example.test/a.png'))
    const saved = await savedPicture('svg', drawnWith(svg))
    expect(saved?.type).toBe('image/svg+xml')
    expect(await saved?.text()).toBe(svg)
    expect(decoded).toEqual([])
  })

  it('writes each page-local picture in as its pixels, decoding a repeated one once', async () => {
    const { decoded, drawImage } = stubDecoder({ 'blob:a': { width: 4, height: 3 } })
    const saved = await savedPicture('svg', drawnWith(svgOf(image('blob:a'), image('blob:a'))))
    const text = (await saved?.text()) ?? ''
    expect(text.match(/href="data:image\/png;base64,AAAA"/g)).toHaveLength(2)
    expect(text).not.toContain('blob:')
    expect(decoded).toEqual(['blob:a'])
    expect(drawImage).toHaveBeenCalledTimes(1)
  })

  it('leaves out a picture that fails to decode, has no pixels, or is over the bound', async () => {
    const { drawImage } = stubDecoder({
      'blob:broken': 'fails',
      'blob:empty': { width: 0, height: 3 },
      'blob:fits': { width: 4, height: 3 },
    })
    const svg = svgOf(image('blob:broken'), image('blob:empty'), image('blob:fits'))
    const text = (await (await savedPicture('svg', drawnWith(svg)))?.text()) ?? ''
    expect(text.match(/href=""/g)).toHaveLength(2)
    expect(text).toContain('href="data:image/png;base64,AAAA"')
    // Only the picture with pixels is ever drawn.
    expect(drawImage).toHaveBeenCalledTimes(1)

    // 'data:image/png;base64,AAAA' is 26 characters, so about 19 bytes.
    const bounded = await savedPicture('svg', drawnWith(svgOf(image('blob:fits'))), {
      maxImageBytes: 8,
    })
    expect(await bounded?.text()).toContain('href=""')
  })

  it('leaves out a picture the encoder answers in another format', async () => {
    stubDecoder({ 'blob:a': { width: 4, height: 3 } }, 'data:,')
    const saved = await savedPicture('svg', drawnWith(svgOf(image('blob:a'))))
    expect(await saved?.text()).toContain('href=""')
  })
})

describe('savedPicture, the PNG path', () => {
  it('rasterises the inlined SVG at the rounded bounds and embeds the source', async () => {
    stubDecoder({ 'blob:a': { width: 4, height: 3 } })
    vi.mocked(rasterizeSvgToPng).mockResolvedValue(new Blob([BARE_PNG], { type: 'image/png' }))
    const saved = await savedPicture('png', drawnWith(svgOf(image('blob:a')), 10.6, 0.2), {
      source: () => '{"nodes":[]}',
    })
    const [rasterised, width, height] = vi.mocked(rasterizeSvgToPng).mock.calls[0] ?? []
    expect(rasterised).toContain('href="data:image/png;base64,AAAA"')
    expect([width, height]).toEqual([11, 1])
    expect(saved?.type).toBe('image/png')
    const bytes = new Uint8Array((await saved?.arrayBuffer()) ?? new ArrayBuffer(0))
    expect(extractTextFromPng(bytes, 'whiteboard')).toBe('{"nodes":[]}')
  })

  it('answers the rasterised picture alone when no source is asked for', async () => {
    const png = new Blob([BARE_PNG], { type: 'image/png' })
    vi.mocked(rasterizeSvgToPng).mockResolvedValue(png)
    expect(await savedPicture('png', drawnWith(svgOf()))).toBe(png)
  })

  it('answers null where this environment cannot rasterise', async () => {
    vi.mocked(rasterizeSvgToPng).mockResolvedValue(null)
    const source = vi.fn(() => 'unused')
    expect(await savedPicture('png', drawnWith(svgOf()), { source })).toBeNull()
    expect(source).not.toHaveBeenCalled()
  })
})
