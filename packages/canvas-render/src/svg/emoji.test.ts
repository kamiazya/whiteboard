import { describe, expect, it } from 'vitest'
import type { Scene } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

const emoji = (char: string, x = 0): Scene['nodes'][number] => ({
  kind: 'emoji',
  emoji: char,
  bbox: { x, y: 0, w: 16, h: 16 },
})

describe('emoji nodes render as a centered text glyph', () => {
  it('one emoji: middle-anchored text sized to the bbox', () => {
    const svg = renderSceneToSvg({ nodes: [emoji('🔒')] })
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<text x="8" y="13.6" font-size="16" text-anchor="middle">🔒</text>' +
        '</svg>',
    )
  })

  it('a non-square bbox sizes the glyph to the SMALLER side, still centered', () => {
    const svg = renderSceneToSvg({
      nodes: [{ kind: 'emoji', emoji: '⭐', bbox: { x: 10, y: 20, w: 40, h: 16 } }],
    })
    expect(svg).toContain('<text x="30" y="33.6" font-size="16" text-anchor="middle">⭐</text>')
  })

  it('an empty string renders nothing (presence-only, like an absent attribute)', () => {
    const svg = renderSceneToSvg({ nodes: [emoji('')] })
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })

  it('a non-finite bbox renders nothing (never throws)', () => {
    const bad: Scene = {
      nodes: [{ kind: 'emoji', emoji: '⭐', bbox: { x: Number.NaN, y: 0, w: 16, h: 16 } }],
    }
    expect(renderSceneToSvg(bad)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })
})
