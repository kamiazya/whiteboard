/**
 * A run marked `paints` draws its picture instead of its glyphs.
 *
 * `renderTextRun` is the single funnel every block routes through — a
 * heading, a paragraph and a table cell all call it — so the substitution
 * lands in one place and no surface can be the one that forgot.
 */

import type { Scene, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from './backend.js'

const run = (extra: Partial<TextRunNode> = {}): TextRunNode => ({
  kind: 'textRun',
  bbox: { x: 10, y: 20, w: 40, h: 16 },
  text: 'a diagram',
  ...extra,
})

const svgOf = (node: TextRunNode): string =>
  renderSceneToSvg({
    nodes: [{ kind: 'paragraph', bbox: { x: 0, y: 0, w: 100, h: 40 }, runs: [node] }],
  } as unknown as Scene)

describe('a run that paints an image', () => {
  it('emits an image in the run box and no text glyphs', () => {
    const svg = svgOf(run({ paints: { kind: 'image', src: 'diagram.png' } }))
    expect(svg).toContain('href="diagram.png"')
    expect(svg).toContain('<image')
    // Checked as the absence of a <text> ELEMENT, not of the string: the
    // accessible-name <title> legitimately carries the same words.
    expect(svg).not.toContain('<text')
  })

  /**
   * The alt is the run's text, and SVG's accessible-name mechanism is a
   * `<title>` child — the same one the BLOCK image node already uses, so
   * the two kinds of image describe themselves the same way.
   */
  it('carries the alt as a title, so it is not silent to a reader', () => {
    const svg = svgOf(run({ paints: { kind: 'image', src: 'diagram.png' } }))
    expect(svg).toContain('<title>a diagram</title>')
  })

  it('leaves an ordinary run drawing its glyphs', () => {
    const svg = svgOf(run())
    expect(svg).toContain('>a diagram<')
    expect(svg).not.toContain('<image')
  })
})
