// The typography and chrome a markdown body is laid out with, calibrated to
// GitHub's rendered-markdown surface (`.markdown-body`) because that is the
// reading experience people already have for this content — matching it is
// cheaper for a reader than learning a second one.
//
// This is DATA, not a resolver: unlike `SpatialAppearanceResolver`, nothing
// here varies per node, so a swap point would be a parameter with one
// caller. `layoutMdastBlocks` reads the frozen constant below.
//
// Every colour is ONE neutral at three opacities rather than a light and a
// dark palette, and that is a load-bearing choice, not a shortcut. Markdown
// body runs deliberately carry no `fill` so they inherit it from whichever
// ancestor sets one — the seam apps/web's editor uses to keep body text
// legible on its dark canvas (SpatialEditor's `fill: editorTextFill(theme)`).
// A per-mode markdown palette would need the mode threaded into
// `layoutMdastBlocks` from four call sites that do not have it, and would
// still leave body text mode-driven from outside. Alpha over the inherited
// surface needs none of that: the same value reads on white and on near-
// black, and `fillOpacity` on a run modulates the INHERITED fill rather than
// replacing it, so muted text stays muted in both modes. GitHub's own inline
// code background is alpha for the same reason (`#818b981f`).
export interface MarkdownTheme {
  /** Body text size (px); every non-heading run is laid out at this size. */
  readonly bodyFontSizePx: number
  /** Multiplier from font size to line box height, CSS `line-height` style. */
  readonly bodyLineHeight: number
  /** Headings pack tighter than prose, as they do on GitHub. */
  readonly headingLineHeight: number
  readonly headingFontSizePx: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, number>>
  /** Gap below every block (GitHub's uniform 16px `margin-bottom`). */
  readonly blockGapPx: number
  /**
   * EXTRA space above a heading, on top of the preceding block's gap. The
   * asymmetry is the point: a heading belongs to what follows it, so more
   * air above than below groups it with its section.
   */
  readonly headingSpaceAbovePx: number
  /** Left indent per list level (GitHub's `padding-left: 2em`). */
  readonly listIndentPx: number
  /**
   * Gap between a list marker's RIGHT edge and its content. The marker is
   * right-aligned against the content edge, which is what
   * `list-style-position: outside` does and why `9.` and `10.` line up in a
   * browser. Anchoring it to the left of the gutter instead leaves the gap
   * to whatever is left over after the glyph — 28px behind a bullet — which
   * reads as a marker that has drifted away from its own item.
   */
  readonly listMarkerGapPx: number
  /**
   * Gap between list items, replacing the full block gap their last child
   * would otherwise leave. A list is one thing; its items should not drift
   * as far apart as two paragraphs.
   */
  readonly listItemGapPx: number
  readonly monoFontFamily: string
  /** Code renders at 85% of body size, GitHub's ratio for both forms. */
  readonly codeFontScale: number
  readonly codeLineHeight: number
  /** Padding inside a fenced block's background box. */
  readonly codeBlockPaddingPx: number
  /** Horizontal padding painted around an inline code run's backdrop. */
  readonly inlineCodePaddingXPx: number
  readonly blockquoteBarWidthPx: number
  /** Distance from the bar to the quoted content. */
  readonly blockquoteGapPx: number
  readonly tableCellPaddingXPx: number
  readonly tableCellPaddingYPx: number
  readonly thematicBreakHeightPx: number
  readonly borderWidthPx: number
  readonly cornerRadiusPx: number
  /** The one neutral every piece of chrome is drawn in. */
  readonly chromeColor: string
  /** Filled panel behind code (block and inline). */
  readonly panelOpacity: number
  /** Rules, borders, and the blockquote bar. */
  readonly borderOpacity: number
  /** Applied to the INHERITED text fill for de-emphasised runs. */
  readonly mutedTextOpacity: number
}

export const MARKDOWN_THEME: MarkdownTheme = Object.freeze({
  bodyFontSizePx: 16,
  bodyLineHeight: 1.55,
  headingLineHeight: 1.25,
  // Compressed for a node rather than a page: a 32px h1 takes a third of a
  // 280px box before a word of content lands. h4-h6 never drop BELOW body
  // size — a heading set smaller than the prose under it reads as a rendering
  // fault on a canvas; rank below h3 comes from weight instead.
  headingFontSizePx: Object.freeze({ 1: 24, 2: 20, 3: 17, 4: 16, 5: 16, 6: 16 }),
  blockGapPx: 12,
  headingSpaceAbovePx: 18,
  listIndentPx: 22,
  listMarkerGapPx: 8,
  listItemGapPx: 4,
  monoFontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  codeFontScale: 0.85,
  codeLineHeight: 1.45,
  codeBlockPaddingPx: 16,
  inlineCodePaddingXPx: 5,
  blockquoteBarWidthPx: 4,
  blockquoteGapPx: 16,
  tableCellPaddingXPx: 13,
  tableCellPaddingYPx: 6,
  thematicBreakHeightPx: 1,
  borderWidthPx: 1,
  cornerRadiusPx: 6,
  chromeColor: '#818b98',
  panelOpacity: 0.12,
  borderOpacity: 0.35,
  mutedTextOpacity: 0.7,
})
