import type { FontDescriptor } from '@kamiazya/whiteboard-canvas-render'
import { afterEach, describe, expect, it } from 'vitest'
import { VIEWER_FONT_FAMILY } from './font.js'
import { createBrowserMeasureText } from './measure-text.js'

/**
 * Before the vendored face loads, or when it never does, the SVG backend
 * draws a run that names Roboto in its emitted stack's fallback. The measurer
 * has to fall back to the SAME face, or every run is placed by one font's
 * advances and drawn in another's: wider glyphs eat the space after them, and
 * space-separated links read as one word.
 */
const SVG_NS = 'http://www.w3.org/2000/svg'
const font: FontDescriptor = {
  family: VIEWER_FONT_FAMILY,
  fallbackChain: [],
  weight: 400,
  style: 'normal',
  sizePx: 16,
}
const SAMPLE = 'Note 0 and Note 1'

/** What the backend draws: the emitted stack, as `appearance_attrs` writes it. */
function drawnWidth(text: string): number {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const node = document.createElementNS(SVG_NS, 'text')
  node.setAttribute('font-family', 'Roboto, system-ui, sans-serif')
  node.setAttribute('font-size', '16')
  node.style.fontKerning = 'none'
  node.textContent = text
  svg.append(node)
  document.body.append(svg)
  const width = node.getComputedTextLength()
  svg.remove()
  return width
}

function holdsRoboto(): boolean {
  for (const face of document.fonts) {
    if (face.family.replace(/^["']|["']$/g, '') === VIEWER_FONT_FAMILY && face.status === 'loaded')
      return true
  }
  return false
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('the browser measurer before the vendored face loads', () => {
  it('measures a Roboto run in the face the SVG draws it in', (ctx) => {
    // The premise, probed: no Roboto here at all, so both sides fall back.
    // A machine with Roboto installed measures and draws the same face either
    // way, and this test would assert nothing there.
    const probe = document.createElement('canvas').getContext('2d')
    if (probe === null) return ctx.skip('no 2D context to measure in')
    probe.font = '16px Roboto'
    const bare = probe.measureText(SAMPLE).width
    probe.font = '16px system-ui, sans-serif'
    const generic = probe.measureText(SAMPLE).width
    if (holdsRoboto() || Math.abs(bare - generic) < 0.5) {
      return ctx.skip('Roboto resolves here, so there is no fallback to disagree on')
    }
    const measured = createBrowserMeasureText()(SAMPLE, font).advanceWidth
    expect(Math.abs(measured - drawnWidth(SAMPLE))).toBeLessThan(0.5)
  })
})
