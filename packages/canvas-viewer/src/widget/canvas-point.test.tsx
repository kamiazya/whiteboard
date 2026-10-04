import { describe, expect, it } from 'vitest'
import { canvasPointFromClick } from './canvas-point.js'

function fakeSvg(options: {
  rect: { left: number; top: number; width: number; height: number }
  viewBox?: string
}): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  if (options.viewBox !== undefined) svg.setAttribute('viewBox', options.viewBox)
  svg.getBoundingClientRect = () => options.rect as DOMRect
  return svg
}

describe('canvasPointFromClick', () => {
  it('maps a bodyless-root SVG (no viewBox) as one user unit per CSS pixel from its corner', () => {
    const svg = fakeSvg({ rect: { left: 10, top: 20, width: 300, height: 150 } })
    expect(canvasPointFromClick(svg, 110, 80)).toEqual({ x: 100, y: 60 })
  })

  it('maps through the viewBox linearly when one is declared', () => {
    // A 600x300 viewBox starting at (-50, -25), drawn into a 300x150 box:
    // every CSS pixel is two user units.
    const svg = fakeSvg({
      rect: { left: 0, top: 0, width: 300, height: 150 },
      viewBox: '-50 -25 600 300',
    })
    expect(canvasPointFromClick(svg, 150, 75)).toEqual({ x: 250, y: 125 })
    expect(canvasPointFromClick(svg, 0, 0)).toEqual({ x: -50, y: -25 })
  })

  it('answers undefined for a zero-size element', () => {
    expect(
      canvasPointFromClick(fakeSvg({ rect: { left: 0, top: 0, width: 0, height: 0 } }), 5, 5),
    ).toBeUndefined()
  })

  it('falls back to the pixel-offset map for an unparseable viewBox', () => {
    // Garbage coordinates out of NaN arithmetic would be worse than the
    // pixel offset, and a click inside a sized element is still an anchor.
    const malformed = fakeSvg({
      rect: { left: 0, top: 0, width: 300, height: 150 },
      viewBox: 'not a box',
    })
    expect(canvasPointFromClick(malformed, 30, 40)).toEqual({ x: 30, y: 40 })
  })
})

describe('canvasPointFromClick — degenerate inputs and rounding', () => {
  const box = { left: 0, top: 0, width: 300, height: 150 }

  it.each([
    ['zero width', { ...box, width: 0 }],
    ['zero height', { ...box, height: 0 }],
    ['negative width', { ...box, width: -5 }],
  ])('answers undefined for a %s element, with or without a viewBox', (_what, rect) => {
    expect(canvasPointFromClick(fakeSvg({ rect }), 5, 5)).toBeUndefined()
    expect(canvasPointFromClick(fakeSvg({ rect, viewBox: '0 0 600 300' }), 5, 5)).toBeUndefined()
  })

  it('rounds each axis to the nearest whole unit in both render shapes', () => {
    expect(canvasPointFromClick(fakeSvg({ rect: box }), 10.5, 20.5)).toEqual({ x: 11, y: 21 })
    expect(
      canvasPointFromClick(fakeSvg({ rect: box, viewBox: '0 0 300 150' }), 10.5, 20.5),
    ).toEqual({ x: 11, y: 21 })
  })

  it('reads a viewBox written with leading, trailing or comma separators', () => {
    for (const viewBox of [' 0 0 600 300 ', '0,0,600,300', '0, 0, 600, 300']) {
      expect(canvasPointFromClick(fakeSvg({ rect: box, viewBox }), 150, 75), viewBox).toEqual({
        x: 300,
        y: 150,
      })
    }
  })

  it.each([
    'a 0 100 100',
    '0 b 100 100',
    '0 0 100',
    '0 0 100 100 5',
    '0 0 0 100',
    '0 0 100 0',
    '0 0 -5 100',
    '-Infinity 0 100 100',
    '0 0 Infinity 100',
  ])('a viewBox of "%s" falls back to the pixel offset rather than NaN, Infinity or a collapsed axis', (viewBox) => {
    expect(canvasPointFromClick(fakeSvg({ rect: box, viewBox }), 30, 40)).toEqual({ x: 30, y: 40 })
  })
})
