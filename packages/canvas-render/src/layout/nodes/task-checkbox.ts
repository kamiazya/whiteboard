/**
 * The checkbox a task list draws where a bullet would go.
 *
 * Its own module because `mdast-blocks.ts` is at its recorded size ceiling
 * (`file-size-budget.test.ts`) and this is a self-contained piece of
 * geometry: a theme, a state and a baseline in, two rects out.
 */
import type { Appearance, ShapeSceneNode } from '../../scene-graph.js'
import type { MarkdownTheme } from '../../theme/markdown-theme.js'

/** Body text's line box, the vertical space a marker centres itself in. */
export type LineHeightOf = (theme: MarkdownTheme) => number

/**
 * The one STROKED paint in a markdown body, and the reason it is one: a task
 * list's checkbox is an outline around nothing. Every other piece of chrome
 * over there paints a surface (`panelPaint`), so nothing else has a stroke.
 */
export function outlinePaint(theme: MarkdownTheme, opacity: number): Appearance {
  return {
    fill: 'none',
    stroke: theme.chromeColor,
    strokeWidth: theme.borderWidthPx,
    strokeOpacity: opacity,
  }
}

/**
 * The checkbox a task item draws where a bullet would go, as RECTS.
 *
 * Not a character: measured against the vendored export face (ADR-0011),
 * U+2713 / U+2714 / U+2610 / U+2611 each draw with exactly the ink of a
 * private-use code point that certainly does not exist (296px against a
 * blank control of 0 and an `A` of 363) — the face carries none of them, so
 * a glyph checkbox exports as a tofu box.
 *
 * Not a path either: `scaleScene` deliberately leaves `svgFragment` content
 * alone (the arrowhead class), so a drawn tick would keep its size while
 * the prose around it grew. A rect's bbox scales like everything else, so
 * the state is carried by INK — an empty box against a filled one — rather
 * than by a mark the renderer might not be able to draw.
 */
export function checkboxMarker(
  theme: MarkdownTheme,
  checked: boolean,
  startY: number,
  lineHeightOf: LineHeightOf,
): readonly ShapeSceneNode[] {
  const size = Math.round(theme.bodyFontSizePx * 0.8)
  // Centred in the first line's box, like a glyph sitting on its baseline
  // would be, and right-aligned against the content edge exactly as the
  // bullet is (see `listMarkerGapPx`).
  const box = {
    x: -(size + theme.listMarkerGapPx),
    y: startY + (lineHeightOf(theme) - size) / 2,
    w: size,
    h: size,
  }
  const frame: ShapeSceneNode = {
    kind: 'shape',
    bbox: box,
    radius: Math.max(theme.cornerRadiusPx / 3, 1),
    appearance: outlinePaint(theme, theme.borderOpacity),
  }
  if (!checked) return [frame]
  const inset = Math.round(size / 4)
  return [
    frame,
    {
      kind: 'shape',
      bbox: { x: box.x + inset, y: box.y + inset, w: size - inset * 2, h: size - inset * 2 },
      radius: Math.max(theme.cornerRadiusPx / 6, 1),
      appearance: { fill: theme.chromeColor, fillOpacity: theme.mutedTextOpacity },
    },
  ]
}
