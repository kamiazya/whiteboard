// What the PNG exporter hands resvg, read at the constructor: the guards that
// hold here are about the INPUT resvg is given, so a picture-level check
// cannot tell a guard that ran from a layout that happened not to need it.

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

import { withoutExternalImages } from './external-images.js'
import { renderSpatialCanvasToPng } from './headless-renderer.js'

const FONTS_DIR = '/nonexistent/wb-resvg-input-fonts'

const canvasNaming = (url: string): SpatialCanvas => ({
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 240, height: 240, text: `![x](${url})` })],
  edges: [],
})

afterEach(() => {
  constructed.svgs.length = 0
})

describe('the image hrefs resvg is given', () => {
  it('keeps a data: image', async () => {
    await renderSpatialCanvasToPng(canvasNaming('data:image/png;base64,AA'), FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
    expect(constructed.svgs[0]).toContain('href="data:image/png;base64,AA"')
  })

  it('drops every href that is not a data: URI before resvg sees it', async () => {
    await renderSpatialCanvasToPng(canvasNaming('https://example.com/x.png'), FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
    expect(constructed.svgs[0]).toContain('<image')
    expect(constructed.svgs[0]).not.toContain('example.com')
  })

  it.each([
    ['an absolute path', '<image x="0" href="/dev/zero"/>', '<image x="0"/>'],
    ['a relative path', '<image href="a.png" x="0"/>', '<image x="0"/>'],
    ['an xlink href', '<image x="0" xlink:href="/etc/hosts"/>', '<image x="0"/>'],
    ['an upper-case data scheme', '<image x="0" href="DATA:image/png,AA"/>', '<image x="0"/>'],
    [
      'a data: URI',
      '<image x="0" href="data:image/png,AA"/>',
      '<image x="0" href="data:image/png,AA"/>',
    ],
  ])('rewrites %s', (_name, input, output) => {
    expect(withoutExternalImages(`<svg>${input}<a href="/kept"/></svg>`)).toBe(
      `<svg>${output}<a href="/kept"/></svg>`,
    )
  })
})

describe('the size of the target resvg is asked for', () => {
  const huge: SpatialCanvas = {
    nodes: [textNode({ id: 'a', x: 0, y: 0, width: 1e6, height: 1e6, text: 'big' })],
    edges: [],
  }

  it('refuses a board past the pixel budget without constructing resvg', async () => {
    await expect(renderSpatialCanvasToPng(huge, FONTS_DIR, { scale: 8 })).rejects.toMatchObject({
      name: 'ExportTooLargeError',
    })
    expect(constructed.svgs).toHaveLength(0)
  })

  it('measures the target after the scale', async () => {
    const wide: SpatialCanvas = {
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 3000, height: 100, text: 'wide' })],
      edges: [],
    }
    await expect(renderSpatialCanvasToPng(wide, FONTS_DIR, { scale: 8 })).rejects.toMatchObject({
      name: 'ExportTooLargeError',
    })
    expect(constructed.svgs).toHaveLength(0)
    await renderSpatialCanvasToPng(wide, FONTS_DIR)
    expect(constructed.svgs).toHaveLength(1)
  })

  it('renders an ordinary board at the largest scale', async () => {
    const result = await renderSpatialCanvasToPng(canvasNaming('data:,'), FONTS_DIR, { scale: 8 })
    expect(constructed.svgs).toHaveLength(1)
    expect(result.width).toBeGreaterThan(240 * 8)
  })
})
