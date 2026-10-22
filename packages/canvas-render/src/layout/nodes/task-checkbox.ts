/**
 * The checkbox a task list draws where a bullet would go.
 *
 * Its own module because `mdast-blocks.ts` is at its recorded size ceiling
 * (`file-size-budget.test.ts`) and this is a self-contained piece of
 * geometry: a theme, a state and a baseline in, a frame and a tick out.
 */
import type { Appearance, ResolvedEdgeNode, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import type { MarkdownTheme } from '../../theme/markdown-theme.js'

/** Body text's line box, the vertical space a marker centres itself in. */
export type LineHeightOf = (theme: MarkdownTheme) => number

/**
 * The one STROKED paint in a markdown body, and the reason it is one: a task
 * list's checkbox is an outline around nothing. Every other piece of chrome
 * over there paints a surface (`panelPaint`), so nothing else has a stroke.
 */
function outlinePaint(theme: MarkdownTheme, opacity: number): Appearance {
  return {
    fill: 'none',
    stroke: theme.chromeColor,
    strokeWidth: theme.borderWidthPx,
    strokeOpacity: opacity,
  }
}

/**
 * The checkbox a task item draws where a bullet would go: an outlined frame,
 * plus a tick inside it once the item is done.
 *
 * Not a character: measured against the vendored export face (ADR-0011),
 * U+2713 / U+2714 / U+2610 / U+2611 each draw with exactly the ink of a
 * private-use code point that certainly does not exist (296px against a
 * blank control of 0 and an `A` of 363) — the face carries none of them, so
 * a glyph checkbox exports as a tofu box.
 *
 * Not an `svgFragment` path either: `scaleScene` deliberately leaves that
 * content alone (the arrowhead class), so a drawn tick would keep its size
 * while the prose around it grew. The tick is an arrowless three-point
 * polyline, whose points scale with everything else; a filled square in its
 * place read as "indeterminate" rather than done.
 */
export function checkboxMarker(
  theme: MarkdownTheme,
  checked: boolean,
  startY: number,
  lineHeightOf: LineHeightOf,
): readonly (ShapeSceneNode | ResolvedEdgeNode)[] {
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
  const tick: ResolvedEdgeNode = {
    kind: 'edge',
    id: 'task-tick',
    path: [
      { x: box.x + size * 0.24, y: box.y + size * 0.52 },
      { x: box.x + size * 0.43, y: box.y + size * 0.72 },
      { x: box.x + size * 0.77, y: box.y + size * 0.3 },
    ],
    fromSide: 'left',
    toSide: 'right',
    fromEnd: 'none',
    toEnd: 'none',
    appearance: {
      stroke: theme.chromeColor,
      strokeWidth: Math.max(theme.borderWidthPx * 1.5, 1.5),
      strokeOpacity: theme.mutedTextOpacity,
    },
  }
  return [frame, tick]
}
