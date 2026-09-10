// Every theme asset keeps the floors the bundled palettes pin, in BOTH of its
// halves: a theme is allowed to change every colour and none of the
// guarantees. The floors are WCAG's — 3:1 for non-text strokes (1.4.11),
// 4.5:1 for text (1.4.3) — against every surface the text can sit on.
import { themeTokensSchema } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { VISUAL_THEMES } from './themes.js'

function channel(hex: string, at: number): number {
  const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('bundled theme assets', () => {
  it('every asset satisfies the token contract', () => {
    for (const [name, tokens] of Object.entries(VISUAL_THEMES)) {
      expect(themeTokensSchema.safeParse(tokens).success, name).toBe(true)
    }
  })

  for (const [name, tokens] of Object.entries(VISUAL_THEMES)) {
    for (const mode of ['light', 'dark'] as const) {
      const palette = tokens.palette[mode]
      describe(`${name} · ${mode}`, () => {
        it('every stroke clears 3:1 against the surface', () => {
          const strokes = [
            palette.edgeStroke,
            ...Object.values(palette.node).map((style) => style.stroke),
            ...Object.values(palette.presets).map((accent) => accent.stroke),
          ]
          for (const stroke of strokes) {
            expect(contrast(stroke, palette.surface), stroke).toBeGreaterThanOrEqual(3)
          }
        })

        it('label text clears 4.5:1 against the surface and every fill it can sit on', () => {
          const fills = [
            palette.surface,
            ...Object.values(palette.node)
              .map((style) => style.fill)
              .filter((fill) => fill !== 'none'),
            ...Object.values(palette.presets).map((accent) => accent.fill),
          ]
          for (const fill of fills) {
            expect(contrast(palette.labelFill, fill), fill).toBeGreaterThanOrEqual(4.5)
          }
        })

        it('every syntax role clears 4.5:1 against the surface', () => {
          for (const [role, colour] of Object.entries(palette.syntax)) {
            expect(contrast(colour, palette.surface), role).toBeGreaterThanOrEqual(4.5)
          }
        })

        it('comment and proposal chrome keep their text legible and their accents visible', () => {
          expect(contrast(palette.labelFill, palette.comment.bubble.fill)).toBeGreaterThanOrEqual(
            4.5,
          )
          expect(
            contrast(palette.comment.bubble.stroke, palette.comment.bubble.fill),
          ).toBeGreaterThanOrEqual(3)
          expect(contrast(palette.labelFill, palette.proposal.bubbleFill)).toBeGreaterThanOrEqual(
            4.5,
          )
          expect(contrast(palette.proposal.edge, palette.surface)).toBeGreaterThanOrEqual(3)
        })
      })
    }
  }

  it('sketch inks and names a family; neon glows and keeps crisp geometry', () => {
    expect(VISUAL_THEMES.sketch.ink).toBe('sketch')
    // A pencil line is drawn straight by default: the routing a person
    // chooses on the Edge routing row is theirs, and the theme fills in only
    // where they said nothing.
    expect(VISUAL_THEMES.sketch.defaults.edgeRouting).toBe('straight')
    expect(VISUAL_THEMES.sketch.fontFamily).toBeDefined()
    expect(VISUAL_THEMES.neon.ink).toBe('clean')
    expect(VISUAL_THEMES.neon.glow?.radiusPx).toBeGreaterThan(0)
  })
})

describe('neon', () => {
  const chroma = (hex: string): number => {
    const c = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
    return Math.max(...c) - Math.min(...c)
  }

  it('lights an unpainted board: the default strokes carry hue, since a grey halo reads as a smudge', () => {
    for (const mode of ['light', 'dark'] as const) {
      const palette = VISUAL_THEMES.neon.palette[mode]
      for (const [kind, style] of Object.entries(palette.node)) {
        if (kind === 'group') continue
        expect(chroma(style.stroke), `${mode} ${kind}`).toBeGreaterThanOrEqual(80)
      }
      expect(chroma(palette.edgeStroke), `${mode} edge`).toBeGreaterThanOrEqual(80)
    }
  })

  it('tells the node kinds apart by stroke in both halves, as the bundled palette does by fill', () => {
    for (const mode of ['light', 'dark'] as const) {
      const { text, file, link } = VISUAL_THEMES.neon.palette[mode].node
      expect(new Set([text.stroke, file.stroke, link.stroke]).size).toBe(3)
    }
  })

  it('declares a line weight the halo can bloom from', () => {
    expect(VISUAL_THEMES.neon.strokeWidthPx).toBeGreaterThanOrEqual(1.5)
  })
})
