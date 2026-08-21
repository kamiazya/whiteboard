import { describe, expect, it } from 'vitest'
import type { Scene } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

const glyph = (char: string, x = 0): Scene['nodes'][number] => ({
  kind: 'glyph',
  glyph: char,
  bbox: { x, y: 0, w: 16, h: 16 },
})

describe('glyph nodes render as a centered text glyph', () => {
  it('one emoji glyph: middle-anchored text sized to the bbox', () => {
    const svg = renderSceneToSvg({ nodes: [glyph('🔒')] })
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<text x="8" y="13.6" font-size="16" text-anchor="middle">🔒</text>' +
        '</svg>',
    )
  })

  it('is not emoji-bound: any character renders the same way', () => {
    const svg = renderSceneToSvg({ nodes: [glyph('済')] })
    expect(svg).toContain('<text x="8" y="13.6" font-size="16" text-anchor="middle">済</text>')
  })

  it('a multi-codepoint grapheme cluster (ZWJ family) is one glyph, unchanged', () => {
    // Composed clusters need no handling here: SVG <text> renders the
    // cluster, and the only length check (empty string) stays correct.
    const svg = renderSceneToSvg({ nodes: [glyph('👨‍👩‍👧')] })
    expect(svg).toContain('>👨‍👩‍👧</text>')
  })

  it('a non-square bbox sizes the glyph to the SMALLER side, still centered', () => {
    const svg = renderSceneToSvg({
      nodes: [{ kind: 'glyph', glyph: '⭐', bbox: { x: 10, y: 20, w: 40, h: 16 } }],
    })
    expect(svg).toContain('<text x="30" y="33.6" font-size="16" text-anchor="middle">⭐</text>')
  })

  it('an empty string renders nothing (presence-only, like an absent attribute)', () => {
    const svg = renderSceneToSvg({ nodes: [glyph('')] })
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })

  it('a non-finite bbox renders nothing (never throws)', () => {
    const bad: Scene = {
      nodes: [{ kind: 'glyph', glyph: '⭐', bbox: { x: Number.NaN, y: 0, w: 16, h: 16 } }],
    }
    expect(renderSceneToSvg(bad)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })
})
