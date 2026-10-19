// An inline `data:` image is decoded by resvg at the size its own header
// declares, on the serving loop. A few hundred encoded bytes can declare a
// 65535x65535 frame, so the export reads every header first and never hands
// resvg an image it has not sized. These tests stop at the constructor seam:
// a refused image must never reach a real decoder in this process.

import { gzipSync } from 'node:zlib'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const constructed = vi.hoisted(() => ({ svgs: [] as string[] }))

vi.mock('@resvg/resvg-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@resvg/resvg-js')>()
  class RecordingResvg extends actual.Resvg {
    constructor(svg: string | Buffer, options?: ConstructorParameters<typeof actual.Resvg>[1]) {
      constructed.svgs.push(String(svg))
      super(svg, options)
    }
  }
  return { ...actual, Resvg: RecordingResvg }
})

import { boundedDataImages } from './data-image-budget.js'
import { EXPORT_MAX_PIXELS } from './export-budget.js'
import { renderSpatialCanvasToPng } from './headless-renderer.js'

const FONTS_DIR = '/nonexistent/wb-data-image-budget-fonts'

const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
const be32 = (n: number): number[] => [...be16(n >>> 16), ...be16(n & 0xffff)]
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** A PNG signature and IHDR declaring `width`x`height`; no pixel data follows. */
const pngHeader = (width: number, height: number): number[] => [
  0x89,
  ...ascii('PNG\r\n\x1a\n'),
  ...be32(13),
  ...ascii('IHDR'),
  ...be32(width),
  ...be32(height),
  8,
  6,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
]

/** SOI, a DQT stub, then SOF0 declaring `width`x`height`, then EOI. */
const jpegHeader = (width: number, height: number, sof = 0xc0): number[] => [
  0xff,
  0xd8,
  0xff,
  0xdb,
  ...be16(3),
  0,
  0xff,
  sof,
  ...be16(11),
  8,
  ...be16(height),
  ...be16(width),
  1,
  1,
  0x11,
  0,
  0xff,
  0xd9,
]

const gifHeader = (sw: number, sh: number, fw: number, fh: number): number[] => [
  ...ascii('GIF89a'),
  ...le16(sw),
  ...le16(sh),
  0,
  0,
  0,
  0x21,
  0xf9,
  4,
  0,
  0,
  0,
  0,
  0,
  0x2c,
  ...le16(0),
  ...le16(0),
  ...le16(fw),
  ...le16(fh),
  0,
]

const webpHeader = (chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): number[] => {
  const head = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0]
  if (chunk === 'VP8 ') {
    return [...head, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)]
  }
  if (chunk === 'VP8L') {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
    return [...head, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]
  }
  const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
  return [...head, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]
}

const dataUrl = (mime: string, bytes: number[]): string =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

const imageSvg = (...hrefs: string[]): string =>
  `<svg width="100" height="100">${hrefs.map((h) => `<image x="0" href="${h}"/>`).join('')}</svg>`

/** A real 1x1 PNG. */
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const canvasNaming = (...urls: string[]): SpatialCanvas => ({
  nodes: urls.map((url, i) =>
    textNode({ id: `n${i}`, x: i * 300, y: 0, width: 240, height: 240, text: `![x](${url})` }),
  ),
  edges: [],
})

afterEach(() => {
  constructed.svgs.length = 0
})

describe('a data: image whose header declares more pixels than the export budget', () => {
  it('refuses a JPEG declaring 65535x65535 before resvg is constructed', async () => {
    const bomb = dataUrl('image/jpeg', jpegHeader(65535, 65535))
    await expect(renderSpatialCanvasToPng(canvasNaming(bomb), FONTS_DIR)).rejects.toMatchObject({
      name: 'ExportTooLargeError',
    })
    expect(constructed.svgs).toHaveLength(0)
  })

  it('refuses a PNG declaring 16384x16384 before resvg is constructed', async () => {
    const bomb = dataUrl('image/png', pngHeader(16384, 16384))
    await expect(renderSpatialCanvasToPng(canvasNaming(bomb), FONTS_DIR)).rejects.toMatchObject({
      name: 'ExportTooLargeError',
    })
    expect(constructed.svgs).toHaveLength(0)
  })

  it('sums the declared pixels across every image in the document', () => {
    const half = dataUrl('image/png', pngHeader(4096, EXPORT_MAX_PIXELS / 4096 / 2))
    expect(() => boundedDataImages(imageSvg(half, half))).not.toThrow()
    expect(() => boundedDataImages(imageSvg(half, half, half))).toThrow(
      expect.objectContaining({ name: 'ExportTooLargeError' }),
    )
  })

  it.each([
    ['a progressive JPEG', 'image/jpeg', jpegHeader(20000, 20000, 0xc2)],
    ['a GIF logical screen', 'image/gif', gifHeader(20000, 20000, 1, 1)],
    ['a GIF frame larger than its screen', 'image/gif', gifHeader(1, 1, 20000, 20000)],
    ['a lossy WebP', 'image/webp', webpHeader('VP8 ', 16000, 16000)],
    ['a lossless WebP', 'image/webp', webpHeader('VP8L', 16384, 16384)],
    ['an extended WebP', 'image/webp', webpHeader('VP8X', 100000, 100000)],
    [
      'an SVG',
      'image/svg+xml',
      ascii('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>'),
    ],
    [
      'an SVG sized by its viewBox',
      'image/svg+xml',
      ascii('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 20000"/>'),
    ],
    [
      'an SVG whose other attribute quotes a smaller size',
      'image/svg+xml',
      ascii(`<svg data-note=' width="1" height="1"' width="20000" height="20000"/>`),
    ],
    [
      'an SVG whose root has a quoted >',
      'image/svg+xml',
      ascii('<svg data-note=">" width="20000" height="20000"/>'),
    ],
    [
      'an SVG after a comment quoting a smaller root',
      'image/svg+xml',
      ascii(
        '<?xml version="1.0"?><!-- <svg width="1" height="1"> --><svg width="20000" height="20000"/>',
      ),
    ],
  ])('reads the size %s declares', (_name, mime, bytes) => {
    expect(() => boundedDataImages(imageSvg(dataUrl(mime, bytes)))).toThrow(
      expect.objectContaining({ name: 'ExportTooLargeError' }),
    )
  })

  it('reads an image written percent-encoded rather than in base64', () => {
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>',
    )
    expect(() => boundedDataImages(imageSvg(`data:image/svg+xml,${svg}`))).toThrow(
      expect.objectContaining({ name: 'ExportTooLargeError' }),
    )
  })

  it('reads an href through its XML character references', () => {
    const encoded = Buffer.from(pngHeader(16384, 16384)).toString('base64')
    const escaped = `<svg width="1" height="1"><image href="data:image/png;base64,${encoded.replace(/A/g, '&#65;')}"/></svg>`
    expect(escaped).toContain('&#65;')
    expect(() => boundedDataImages(escaped)).toThrow(
      expect.objectContaining({ name: 'ExportTooLargeError' }),
    )
  })
})

describe('a data: image the exporter cannot size', () => {
  it.each([
    ['a header too short to read', 'data:image/png;base64,AA'],
    ['a type not on the allowlist', dataUrl('image/bmp', pngHeader(1, 1))],
    ['no type at all', 'data:,AA'],
    ['plain text resvg would sniff', dataUrl('text/plain', pngHeader(1, 1))],
    ['bytes of another format than declared', dataUrl('image/png', jpegHeader(1, 1))],
    ['a JPEG whose height is left to a later marker', dataUrl('image/jpeg', jpegHeader(1, 0))],
    [
      'a JPEG with a marker before its frame a decoder may not skip by length',
      dataUrl('image/jpeg', [0xff, 0xd8, 0xff, 0x01, 0, 2, ...jpegHeader(1, 1).slice(2)]),
    ],
    ['a parameter besides base64', `data:image/png;x=1;base64,${ONE_PIXEL_PNG.split(',')[1]}`],
    [
      'base64 with characters outside the alphabet',
      `${ONE_PIXEL_PNG.slice(0, 40)}*${ONE_PIXEL_PNG.slice(40)}`,
    ],
    [
      'an SVG root attribute with an unquoted value',
      dataUrl('image/svg+xml', ascii('<svg width=1 height="1"/>')),
    ],
    [
      'an SVG whose root repeats an attribute',
      dataUrl('image/svg+xml', ascii('<svg width="1" height="1" width="20000"/>')),
    ],
    // An explicit size this reader cannot convert is resvg's to decide, not
    // the viewBox's: 20000pt is 26667px however small the viewBox says.
    [
      'an SVG sized in a unit besides px',
      dataUrl('image/svg+xml', ascii('<svg width="20000pt" height="20000pt" viewBox="0 0 1 1"/>')),
    ],
    [
      'an SVG sized in percent of its viewBox',
      dataUrl('image/svg+xml', ascii('<svg width="100%" height="100%" viewBox="0 0 1 1"/>')),
    ],
    [
      'an SVG giving one explicit length',
      dataUrl('image/svg+xml', ascii('<svg width="20000" viewBox="0 0 1 1"/>')),
    ],
    [
      'an SVG sized in percent',
      dataUrl('image/svg+xml', ascii('<svg width="100%" height="100%"/>')),
    ],
  ])('drops %s instead of trusting it', (_name, href) => {
    const out = boundedDataImages(imageSvg(href))
    expect(out).toContain('<image x="0"/>')
    expect(out).not.toContain('href=')
  })

  it('keeps a readable image within the budget', () => {
    expect(boundedDataImages(imageSvg(ONE_PIXEL_PNG))).toContain(`href="${ONE_PIXEL_PNG}"`)
  })

  it('hands resvg a readable image unchanged', async () => {
    await renderSpatialCanvasToPng(canvasNaming(ONE_PIXEL_PNG), FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
    expect(constructed.svgs[0]).toContain(`href="${ONE_PIXEL_PNG}"`)
  })

  it('hands resvg no unreadable image', async () => {
    await renderSpatialCanvasToPng(canvasNaming('data:image/png;base64,AA'), FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
    expect(constructed.svgs[0]).toContain('<image')
    expect(constructed.svgs[0]).not.toContain('data:image/png;base64,AA')
  })
})

// resvg rasterises a nested SVG's filters at device resolution, synchronously:
// one feMorphology of radius 10 over a 100px image took 17.7s at export
// scale 8 (`scripts/measure/nested-svg-filter-cost.mjs`). The declared size
// says nothing about that work, so an SVG that asks for it is not drawn.
describe('a data: SVG image that asks resvg for work its size does not bound', () => {
  const svgImage = (body: string, root = 'width="10" height="10"'): string =>
    dataUrl('image/svg+xml', ascii(`<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`))

  it.each([
    ['a filter element', '<filter id="f"><feMorphology radius="999"/></filter>'],
    ['a filter primitive outside a filter', '<feGaussianBlur stdDeviation="9"/>'],
    ['a namespaced filter', '<s:filter xmlns:s="http://www.w3.org/2000/svg" id="f"/>'],
    ['a namespaced filter primitive', '<s:feFlood xmlns:s="http://www.w3.org/2000/svg"/>'],
    ['a filter attribute', '<rect width="10" height="10" filter="url(#f)"/>'],
    ['a spaced filter attribute', '<rect width="10" height="10" filter = "url(#f)"/>'],
    ['a CSS filter with a comment before its colon', '<style>rect{filter/**/:blur(9px)}</style>'],
    ['a CSS filter in a style attribute', '<rect style="filter: blur(9px)"/>'],
    ['a CSS filter in a style element', '<style>rect{filter:blur(9px)}</style><rect/>'],
    ['a filter spelled with a character reference', '<rect style="f&#105;lter:blur(9px)"/>'],
    ['a filter spelled with a CSS escape', '<style>rect{f\\69lter:blur(9px)}</style><rect/>'],
    ['an entity that could expand into one', '<!DOCTYPE svg [<!ENTITY f "x">]><rect/>'],
    ['an image of its own', '<image href="data:image/png;base64,AA"/>'],
    ['a mask element', '<mask id="m"><rect width="10" height="10" fill="white"/></mask>'],
    ['a namespaced mask', '<s:mask xmlns:s="http://www.w3.org/2000/svg" id="m"/>'],
    ['a mask attribute', '<g mask="url(#m)"><rect width="10" height="10"/></g>'],
    ['a spaced mask attribute', '<g mask = "url(#m)"><rect width="10" height="10"/></g>'],
    ['a CSS mask in a style attribute', '<g style="mask: url(#m)"><rect/></g>'],
    ['a CSS mask-image', '<style>g{mask-image:url(#m)}</style><g><rect/></g>'],
    ['a CSS mask with a comment before its colon', '<style>g{mask/**/:url(#m)}</style>'],
    ['a mask spelled with a character reference', '<g style="m&#97;sk:url(#m)"><rect/></g>'],
  ])('drops one carrying %s', (_name, body) => {
    const out = boundedDataImages(imageSvg(svgImage(body)))
    expect(out).toContain('<image x="0"/>')
    expect(out).not.toContain('href=')
  })

  // A prefix is any XML name, not only an ASCII one: the element half of the
  // pattern has to see a filter under one without the attribute half's help.
  it.each([
    [
      'a filter under a non-ASCII prefix',
      '<é:filter xmlns:é="http://www.w3.org/2000/svg" id="f"/>',
    ],
    [
      'a filter primitive under a non-ASCII prefix',
      '<é:feMorphology xmlns:é="http://www.w3.org/2000/svg" radius="999"/>',
    ],
    [
      'an image under a non-ASCII prefix',
      '<名:image xmlns:名="http://www.w3.org/2000/svg" href="x"/>',
    ],
    ['a mask under a non-ASCII prefix', '<é:mask xmlns:é="http://www.w3.org/2000/svg" id="m"/>'],
  ])('drops one carrying %s', (_name, body) => {
    const href = `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${body}</svg>`,
    ).toString('base64')}`
    const out = boundedDataImages(imageSvg(href))
    expect(out).toContain('<image x="0"/>')
    expect(out).not.toContain('href=')
  })

  // resvg reads a gzip-compressed SVG and a UTF-16 one, while the filter scan
  // reads UTF-8 text: neither may be drawn, filter or not, since nothing here
  // has seen what it asks for.
  const FILTERED =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><filter id="f"><feMorphology radius="999"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>'

  // Compressed bytes are arbitrary, so one may happen to hold a `<` or `\`
  // the scan refuses on sight, and the case would pass without reaching the
  // sizer at all. Padding the comment until no such byte appears makes the
  // sizer the only thing that can drop it.
  const svgzTheScanCannotRead = (): number[] => {
    for (let pad = 0; pad < 200; pad++) {
      const bytes = gzipSync(`<!--${'x'.repeat(pad)}-->${FILTERED}`)
      if (
        !bytes.includes(0x3c) &&
        !bytes.includes(0x5c) &&
        !/filter/i.test(bytes.toString('latin1'))
      ) {
        return [...bytes]
      }
    }
    throw new Error('no padding gave compressed bytes free of < and \\')
  }

  it.each([
    ['gzip-compressed (svgz)', svgzTheScanCannotRead],
    ['UTF-16LE with a byte-order mark', () => [...Buffer.from(`\uFEFF${FILTERED}`, 'utf16le')]],
    [
      'UTF-16BE with a byte-order mark',
      () => [...Buffer.from(`\uFEFF${FILTERED}`, 'utf16le').swap16()],
    ],
  ])('drops a filtered SVG encoded %s', (_name, encoded) => {
    const out = boundedDataImages(imageSvg(dataUrl('image/svg+xml', encoded())))
    expect(out).toContain('<image x="0"/>')
    expect(out).not.toContain('href=')
  })

  it('drops one whose filter is percent-encoded', () => {
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><filter id="f"/></svg>',
    )
    expect(boundedDataImages(imageSvg(`data:image/svg+xml,${svg}`))).not.toContain('href=')
  })

  it.each([
    ['a label naming the word', '<text x="0" y="9">Filter</text>'],
    ['a title naming the word', '<title>filter results</title><rect width="10" height="10"/>'],
    ['an id naming the word', '<rect id="filtered" width="10" height="10"/>'],
    ['a label naming a mask', '<text x="0" y="9">Mask</text>'],
    ['an id naming a mask', '<rect id="masked" width="10" height="10"/>'],
  ])('keeps one carrying %s', (_name, body) => {
    const kept = svgImage(body)
    expect(boundedDataImages(imageSvg(kept))).toContain(`href="${kept}"`)
  })

  it('keeps a plain SVG within the budget', () => {
    const plain = svgImage('<rect width="10" height="10" fill="red"/>')
    expect(boundedDataImages(imageSvg(plain))).toContain(`href="${plain}"`)
  })

  // The refusal reads inside data images only: the export's own document
  // may mask (canvas-render's fades do), and that is drawn.
  it('keeps a mask in the document around a kept image', () => {
    const outer = `<svg width="100" height="100"><mask id="fade"><rect width="100" height="100" fill="white"/></mask><g mask="url(#fade)"><image x="0" href="${ONE_PIXEL_PNG}"/></g></svg>`
    expect(boundedDataImages(outer)).toBe(outer)
  })

  it('hands resvg no masked SVG from a text node body', async () => {
    const masked = svgImage(
      '<mask id="m"><rect width="10000000" height="10000000" fill="white"/></mask><g mask="url(#m)"><rect width="10000000" height="10000000"/></g>',
      'width="1" height="1"',
    )
    await renderSpatialCanvasToPng(canvasNaming(masked), FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
    expect(constructed.svgs[0]).toContain('<image')
    expect(constructed.svgs[0]).not.toContain(masked)
  })

  it('hands resvg no filtered SVG from a text node body', async () => {
    const filtered = svgImage(
      '<filter id="f"><feMorphology radius="1"/></filter><rect width="10" height="10" filter="url(#f)"/>',
    )
    await renderSpatialCanvasToPng(canvasNaming(filtered), FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
    expect(constructed.svgs[0]).toContain('<image')
    expect(constructed.svgs[0]).not.toContain(filtered)
  })
})
