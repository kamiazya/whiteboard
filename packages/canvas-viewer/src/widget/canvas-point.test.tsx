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

  it('answers undefined for a zero-size element or an unparseable viewBox', () => {
    expect(
      canvasPointFromClick(fakeSvg({ rect: { left: 0, top: 0, width: 0, height: 0 } }), 5, 5),
    ).toBeUndefined()
    // A malformed viewBox falls back to the pixel-offset map rather than
    // producing garbage coordinates out of NaN arithmetic.
    const malformed = fakeSvg({
      rect: { left: 0, top: 0, width: 300, height: 150 },
      viewBox: 'not a box',
    })
    expect(canvasPointFromClick(malformed, 30, 40)).toEqual({ x: 30, y: 40 })
  })
})
