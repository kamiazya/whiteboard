// The vocabulary every markdown layout module shares: what a caller hands
// `layoutMdastBlocks`, what a renderer answers, the cursor a block advances,
// and the theme arithmetic each block reads. Below the block modules by
// position, so the code block, the table and the dispatcher reach for it
// and never for each other.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type {
  Appearance,
  SceneNode,
  SvgFragmentNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import type { FontDescriptor, MeasureText } from '../../measure.js'
import { clampAdvance } from '../../measure.js'
import type { ReferenceSeams } from '../../references/seams.js'
import { MARKDOWN_THEME_NODE, type MarkdownTheme } from '../../theme/markdown-theme.js'

export const BODY_FONT_SIZE_PX = MARKDOWN_THEME_NODE.bodyFontSizePx
export const BODY_LINE_HEIGHT_PX = bodyLineHeightPx(MARKDOWN_THEME_NODE)

/** Derived metrics, per theme rather than per module. */
export function bodyLineHeightPx(theme: MarkdownTheme): number {
  return theme.bodyFontSizePx * theme.bodyLineHeight
}
export function codeFontSizePx(theme: MarkdownTheme): number {
  return theme.bodyFontSizePx * theme.codeFontScale
}
export function codeLineHeightPx(theme: MarkdownTheme): number {
  return codeFontSizePx(theme) * theme.codeLineHeight
}

/**
 * Every piece of markdown chrome, drawn as one neutral at an opacity: the
 * code surface, the blockquote rail, a table's row separators, the thematic
 * break. There is no stroked variant — a markdown body draws surfaces and
 * hairlines, never an outline around content.
 */
export function panelPaint(theme: MarkdownTheme, opacity: number): Appearance {
  return { fill: theme.chromeColor, fillOpacity: opacity }
}

/**
 * Where a line's glyphs sit inside a line box taller than the font. CSS
 * calls it half-leading: the extra height splits evenly above and below, so
 * a 16px run in a 24px box has 4px of air on each side rather than sitting
 * on the box's top edge.
 */
export function baselineIn(lineHeightPx: number, fontSizePx: number, ascent: number): number {
  return (lineHeightPx - fontSizePx) / 2 + ascent
}

/**
 * The font a laid-out run was measured with, rebuilt from what the run
 * declares: every run is stamped with the family and size it was measured
 * at (see `pushRun`), and its weight and slant are its own flags. Undefined
 * for a run that declares neither, which nothing in this file emits.
 */
export function runFontOf(run: TextRunNode): FontDescriptor | undefined {
  const family = run.appearance?.fontFamily
  const sizePx = run.appearance?.fontSize
  if (family === undefined || sizePx === undefined) return undefined
  return bodyFont(family, sizePx, { emphasis: run.emphasis, strong: run.strong })
}

export function bodyFont(
  family: string,
  sizePx: number,
  style: { emphasis?: boolean; strong?: boolean } = {},
) {
  // Bold glyphs are wider: a strong run measured at 400 would wrap at
  // positions the painted 700 text does not occupy (the measured-vs-declared
  // invariant this file already holds for family and size).
  return {
    family,
    fallbackChain: [],
    weight: style.strong === true ? 700 : 400,
    style: style.emphasis === true ? ('italic' as const) : ('normal' as const),
    sizePx,
  }
}

/**
 * The closed set of things a code token can be. Five roles including plain
 * (a token with no role), not forty TextMate scopes: at 10-12px inside a
 * node, finer resolution is discarded on the way out, and each role has to
 * hold its own contrast floor against the code surface.
 */
export type CodeTokenRole = 'keyword' | 'string' | 'number' | 'comment'

export interface CodeToken {
  readonly text: string
  /** Absent means plain — the token paints as body text. */
  readonly role?: CodeTokenRole
}

/** One array per source line, in source order. */
export type CodeTokenLines = readonly (readonly CodeToken[])[]

export interface MdastLayoutOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  /**
   * Family every body run is measured with AND declares in its emitted
   * appearance. Required, and deliberately one field for both roles: body
   * runs are placed per word at absolute x coordinates computed from
   * `measure`, so a run drawn in any family other than the measured one
   * renders each word at a width the layout did not account for — the error
   * is visible as uneven word gaps. A separate "measure family" and
   * "declared family" could drift; one field cannot.
   */
  readonly fontFamily: string
  /**
   * The metrics this body is laid out with. Defaults to the NODE theme.
   *
   * One theme cannot serve both surfaces this function has: a 280px node on a
   * canvas, and the markdown editor's preview pane at a readable measure. The
   * compression that stops a heading eating a third of a node leaves the same
   * heading timid on a page, so the caller says which it is rendering.
   */
  readonly theme?: MarkdownTheme
  /**
   * The fill every body run is painted with — the theme's per-mode text
   * colour, supplied by the caller exactly as `fontFamily` is.
   *
   * Body runs used to carry NO fill and inherit one from whatever ancestor
   * the host set, which put the most-read colour on the canvas outside the
   * one appearance producer and outside the contrast tests that guard the
   * rest of it. Muted runs still modulate it with `fillOpacity` rather than
   * naming a second colour, so "muted" tracks the mode for free.
   *
   * Absent, runs carry no fill and inherit, as before — the SVG is then only
   * legible where an ancestor sets one.
   */
  readonly textFill?: string
  /**
   * Tokenises a fenced block for syntax highlighting — one array per SOURCE
   * line, each token carrying a ROLE rather than a colour. Same injected-
   * seam class as `renderMath`/`renderDiagram`: this package is allowed two
   * third-party dependencies and a highlighter is not going to be the third,
   * so the grammars live in whichever composition root wants them.
   *
   * Roles, not colours, so the palette stays with the one appearance
   * producer instead of being duplicated into every root that installs a
   * highlighter — which is exactly the multi-producer divergence the theme
   * layer exists to delete.
   *
   * TOTAL from this side: a throw, `undefined`, an unknown language, or a
   * line count that disagrees with the source all fall back to plain code.
   * The source is the authority on how many lines a fence has, because that
   * is what the block's height is computed from.
   */
  readonly highlightCode?: (lang: string, value: string) => CodeTokenLines | undefined
  /** The fill for each token role. Absent, a tokenised run paints as body text. */
  readonly syntax?: Partial<Readonly<Record<CodeTokenRole, string>>>
  /**
   * Renders a math source string to an SVG fragment. Optional composition-
   * root seam — MathJax itself is never imported by this package. Absent a
   * real renderer, math nodes fall back to a deterministic placeholder
   * fragment carrying the raw source as escaped text. A renderer that knows
   * the fragment's intrinsic size returns the object form so the block's
   * bbox matches what is painted (width clamps to the column); a plain
   * string keeps the source-line-count fallback height. `undefined` (a
   * renderer that has not produced this value yet — an async renderer's
   * cache miss) falls back to the escaped-source placeholder.
   */
  readonly renderMath?: (
    value: string,
    displayMode: boolean,
  ) => string | RenderedSvgFragment | undefined
  /**
   * Renders a fenced code block's content as a diagram (mermaid and
   * friends) — same injected-resolver class as `renderMath`: synchronous,
   * optional, caller-supplied, total from this side. Called for every
   * fence with a language; `undefined` (any language the caller does not
   * handle) or a throw keeps the plain code block.
   */
  readonly renderDiagram?: (lang: string, value: string) => string | RenderedSvgFragment | undefined
  /**
   * Resolves an embed target's already-parsed body — the same injected-
   * resolver class as `renderMath` and spatial-canvas's `resolveFile*`
   * seams: synchronous, optional, caller-supplied, and TOTAL from this
   * side (a throw or `undefined` degrades to an `embedPlaceholder`, never
   * an aborted layout). A paragraph whose sole child is an embed lays the
   * resolved body out inline under an `embedResolved` node, capped at
   * `EMBED_DEPTH_CAP` with path-local cycle detection (decision 4); an
   * embed mixed into prose stays a link run, labeled with
   * `title` when known.
   */
  readonly resolveEmbed?: (documentId: string) => EmbeddedDocument | undefined
  /**
   * Every reference seam at once, built by `referenceSeams` from what a
   * keeper loaded. The form a composition root passes: the individual
   * seams above stay for a caller probing one in isolation, but a root
   * that hands over the bundle cannot forget one of them.
   */
  readonly references?: ReferenceSeams
  /**
   * Draws a canvas-targeted embed's miniature into the box the typesetter
   * reserves for it. The typesetter owns the frame, the title and the
   * vertical space; the composer owns the picture, because laying a canvas
   * out is the composer's job and this cluster may not import it
   * (`layer-boundary.test.ts`). Same resolver class as `resolveEmbed`:
   * synchronous, total from this side (a throw or `undefined` keeps the
   * framed title with nothing under it). The public `layoutMdastBlocks`
   * defaults it to the spatial composer; only this module's raw entry
   * leaves it unset.
   */
  readonly layoutEmbeddedCanvas?: (
    canvas: SpatialCanvas,
    box: EmbeddedCanvasBox,
  ) => EmbeddedCanvasMiniature | undefined
  /**
   * Documents already on the embed recursion path when this body is itself
   * embedded content — a canvas text node's body, a file node's markdown —
   * so the cycle and depth checks span the markdown/canvas boundary rather
   * than restarting on each side of it. Absent at the top level.
   */
  readonly embedPath?: readonly string[]
  /**
   * The current display name for a linked document, labeling a bare
   * `[[path]]` at render time (an explicit `|label` always wins). Separate
   * from `resolveEmbed` because a label lookup must not cost a content
   * load. Absent or unknown, the id is the honest fallback.
   */
  readonly resolveTitle?: (documentId: string) => string | undefined
}

/**
 * The object form a math/diagram renderer returns when it knows the
 * fragment's intrinsic size. Plain TS, in-process only (zod-schema-
 * discipline: no boundary crossed).
 */
export interface RenderedSvgFragment {
  readonly svg: string
  readonly width?: number
  readonly height?: number
}

/**
 * What an embed target resolves to: a markdown document's parsed body, or a
 * spatial document's canvas. Discriminated by which field is present, the
 * way `ResolvedReference` is on the spatial side.
 */
export type EmbeddedDocument =
  | { readonly title?: string; readonly root: MdastRoot }
  | { readonly title?: string; readonly canvas: SpatialCanvas }

/** The box a canvas miniature may occupy, in the body's own coordinates. */
export interface EmbeddedCanvasBox {
  readonly x: number
  readonly y: number
  readonly maxWidth: number
  readonly maxHeight: number
  /** The recursion path INCLUDING the canvas being drawn. */
  readonly embedPath: readonly string[]
}

/** A miniature already placed inside its box; `w`/`h` is the extent used. */
export interface EmbeddedCanvasMiniature {
  readonly nodes: readonly SceneNode[]
  readonly w: number
  readonly h: number
}

/** `MdastLayoutOptions` after `resolveTheme` — `theme` is no longer optional. */
export type ResolvedMdastOptions = MdastLayoutOptions & { readonly theme: MarkdownTheme }

export interface Cursor {
  y: number
  /**
   * Left origin every run and block box is offset by. Only a blockquote
   * moves it (indenting its content past the accent bar); it is threaded on
   * the cursor rather than through `MdastLayoutOptions` because it is
   * internal bookkeeping, not a caller-facing knob. Lists indent through
   * `listItem.bbox.x` and an SVG transform instead — adding a third
   * transform boundary would break translate-scene.ts's invariant.
   */
  x: number
}

export function measureRunWidth(
  measure: MeasureText,
  fontFamily: string,
  text: string,
  sizePx: number,
  style: { emphasis?: boolean; strong?: boolean } = {},
): number {
  const metrics = measure(text, bodyFont(fontFamily, sizePx, style))
  return clampAdvance(metrics.advanceWidth)
}

/** Result of laying out one block's inline phrasing content. */
export interface PhrasingLayout {
  readonly runs: readonly TextRunNode[]
  /** Number of lines produced (>= 1); a hard break starts a new line. */
  readonly lineCount: number
  /**
   * How far right the runs actually paint. Not always `maxWidth`: an atomic
   * run (inline code, raw HTML, inline math) is never split, so it can still
   * exceed the wrap width, and a block that declares `maxWidth` regardless is
   * lying to `sceneBounds`, the export viewBox and the editor's auto-fit.
   */
  readonly inkWidth: number
}

/**
 * Places a renderer-supplied SVG fragment at the cursor, sized from the
 * dimensions the renderer reported. Width clamps to the column; a missing
 * or non-finite dimension falls back to the column width / one code line,
 * keeping layout total against a renderer that reports garbage.
 */
export function placeFragment(
  rendered: string | RenderedSvgFragment,
  cursor: Cursor,
  options: ResolvedMdastOptions,
): SvgFragmentNode {
  const fragment = typeof rendered === 'string' ? { svg: rendered } : rendered
  const width =
    fragment.width !== undefined && Number.isFinite(fragment.width) && fragment.width > 0
      ? Math.min(fragment.width, options.maxWidth)
      : options.maxWidth
  const height =
    fragment.height !== undefined && Number.isFinite(fragment.height) && fragment.height > 0
      ? fragment.height
      : codeLineHeightPx(options.theme)
  const node: SvgFragmentNode = {
    kind: 'svgFragment',
    bbox: { x: 0, y: cursor.y, w: width, h: height },
    svg: fragment.svg,
  }
  cursor.y += height + options.theme.blockGapPx
  return node
}
