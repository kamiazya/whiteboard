import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { LineBreaker } from 'css-line-break'
import type { MeasureText } from '../../measure.js'
import { clampAdvance } from '../../measure.js'
import type {
  Appearance,
  BlockquoteNode,
  CodeBlockNode,
  EmbedPlaceholderNode,
  EmbedResolvedNode,
  HeadingBlockNode,
  LinkProvenance,
  ListBlockNode,
  ListItemNode,
  ParagraphBlockNode,
  RawHtmlNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  SvgFragmentNode,
  TableBlockNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
  ThematicBreakNode,
  UnresolvedReferenceNode,
} from '../../scene-graph.js'
import { escapeXmlText } from '../../svg/format.js'
import { MARKDOWN_THEME_NODE, type MarkdownTheme } from '../../theme/markdown-theme.js'
import { jaModel } from '../../vendor/budoux/ja-model.js'
import { Parser } from '../../vendor/budoux/parser.js'
import { fitToWidth } from './truncate.js'

/**
 * Every layout constant comes from ONE theme object (theme/markdown-theme.ts),
 * calibrated to GitHub's rendered-markdown surface. Read once here so the
 * rest of the file reads as geometry rather than as a table of numbers, and
 * so restyling stays a data change.
 */
// The metrics a NODE is laid out with. Exported because `apps/web`'s edit
// overlay has to sit on the same line box the render draws, and a node is what
// it edits — see MdastLayoutOptions.theme for the surface that differs.
export const BODY_FONT_SIZE_PX = MARKDOWN_THEME_NODE.bodyFontSizePx
export const BODY_LINE_HEIGHT_PX = bodyLineHeightPx(MARKDOWN_THEME_NODE)

/** Derived metrics, per theme rather than per module. */
function bodyLineHeightPx(theme: MarkdownTheme): number {
  return theme.bodyFontSizePx * theme.bodyLineHeight
}
function codeFontSizePx(theme: MarkdownTheme): number {
  return theme.bodyFontSizePx * theme.codeFontScale
}
function codeLineHeightPx(theme: MarkdownTheme): number {
  return codeFontSizePx(theme) * theme.codeLineHeight
}

/**
 * Every piece of markdown chrome, drawn as one neutral at an opacity: the
 * code surface, the blockquote rail, a table's row separators, the thematic
 * break. There is no stroked variant — a markdown body draws surfaces and
 * hairlines, never an outline around content.
 */
function panelPaint(theme: MarkdownTheme, opacity: number): Appearance {
  return { fill: theme.chromeColor, fillOpacity: opacity }
}

/**
 * Where a line's glyphs sit inside a line box taller than the font. CSS
 * calls it half-leading: the extra height splits evenly above and below, so
 * a 16px run in a 24px box has 4px of air on each side rather than sitting
 * on the box's top edge.
 */
function baselineIn(lineHeightPx: number, fontSizePx: number, ascent: number): number {
  return (lineHeightPx - fontSizePx) / 2 + ascent
}

function bodyFont(
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
   * `EMBED_DEPTH_CAP` with path-local cycle detection (the embed-recursion
   * contract); an embed mixed into prose stays a link run, labeled with
   * `title` when known.
   */
  readonly resolveEmbed?: (documentId: string) => EmbeddedDocument | undefined
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

/** Root depth is 0; mirrors embed-recursion.ts's cap and cycle semantics. */
const EMBED_DEPTH_CAP = 3

/** `resolveTitle` guarded to the never-throw rule. */
function tryResolveTitle(options: ResolvedMdastOptions, documentId: string): string | undefined {
  try {
    return options.resolveTitle?.(documentId)
  } catch {
    return undefined
  }
}

/** `resolveEmbed` guarded to the never-throw rule. */
function tryResolveEmbed(
  options: ResolvedMdastOptions,
  documentId: string,
): EmbeddedDocument | undefined {
  try {
    return options.resolveEmbed?.(documentId)
  } catch {
    return undefined
  }
}

/**
 * Fallback used only when the composition root has not supplied a real
 * math renderer. `value` is untrusted markdown-embedded math source, so it
 * must be escaped like any other text content — unlike a `renderMath`
 * result (or an `SvgFragmentNode.svg`), which is the composition root's own
 * precondition to supply as well-formed, already-trusted SVG.
 */
function defaultRenderMath(value: string): string {
  // y in em, not 0: SVG <text> y is the BASELINE, and the fragment wrapper
  // positions this at its box top — a baseline of 0 would paint the source
  // one line ABOVE the fragment's own space, colliding with the preceding
  // block (the embedPlaceholder baseline rationale, in fragment-local units).
  return `<text y="0.8em">${escapeXmlText(value)}</text>`
}

interface Cursor {
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

function isFinitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function measureRunWidth(
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
interface PhrasingLayout {
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
 * Break opportunities per UAX #14 with CSS `line-break: strict` — the same
 * algorithm a browser applies to `<p>`, which is where Japanese kinsoku
 * lives: a closing character never starts a line and an opening character
 * never ends one, and between two CJK ideographs almost anywhere is a break.
 * Each returned segment carries its own trailing whitespace.
 *
 * `wordBreak: 'normal'` is deliberate: `break-all` would also break English
 * mid-word, and an over-wide segment is handled where it arises (by finer
 * segments, then by code point) rather than by loosening the rule for every
 * string.
 */
function uaxSegments(text: string): readonly string[] {
  const breaker = LineBreaker(text, { lineBreak: 'strict', wordBreak: 'normal' })
  const segments: string[] = []
  for (let entry = breaker.next(); entry.done !== true; entry = breaker.next()) {
    segments.push(entry.value.slice())
  }
  return segments
}

/**
 * UAX #14 says a Japanese line MAY break between almost any two characters,
 * which is enough to keep text inside its box and not enough to read well —
 * it breaks mid-word, which no Japanese typesetter would. BudouX supplies
 * phrase (文節) boundaries, a strict subset of those opportunities, so
 * preferring them costs nothing in fit and buys a line that breaks where a
 * reader would pause.
 *
 * Pure and DOM-free (verified in a worker before adopting), and its output is
 * a total function of its input, which is what the byte-identical-SVG
 * guarantee needs.
 *
 * Built on first Japanese text rather than at module load: the constructor
 * turns a ~24KB model into a Map, and charging that to whichever lazily
 * imported chunk happens to pull this module in makes every consumer pay for
 * a script it may never lay out. Two apps/web browser tests went red on
 * exactly that before this was made lazy.
 *
 * The parser and its model are VENDORED rather than depended on: budoux's
 * only entry point drags in `linkedom` and from there the native `canvas`
 * package, which breaks the published mcp-server build outright. See
 * `../vendor/budoux/README.md`.
 */
let japaneseParser: Parser | undefined

function parseJapanesePhrases(text: string): readonly string[] {
  japaneseParser ??= new Parser(jaModel)
  return japaneseParser.parse(text)
}

/** Hiragana and katakana — the scripts the bundled BudouX model is trained on. */
const KANA_PATTERN = /[\u3040-\u30ff]/

/**
 * The coarsest useful break opportunities: phrases where the text is Japanese,
 * UAX #14 segments otherwise. Chinese and Korean deliberately stay on UAX #14
 * — BudouX ships separate models for them and one model per script is weight
 * this package has no evidence it needs yet.
 */
function breakSegments(text: string): readonly string[] {
  return KANA_PATTERN.test(text) ? parseJapanesePhrases(text) : uaxSegments(text)
}

/**
 * One level finer than `segment`, for when it does not fit a line of its own.
 * A phrase resolves to its UAX #14 segments; something UAX #14 already calls
 * atomic (a long identifier, a URL with no separator left) resolves to code
 * points, which is the floor.
 */
function finerSegments(segment: string): readonly string[] {
  const finer = uaxSegments(segment)
  return finer.length > 1 ? finer : [...segment]
}

/**
 * A block's declared width. Normally the wrap width, but widened to cover an
 * atomic run that could not be split — the bbox has to describe what is
 * painted, since `sceneBounds` and every consumer downstream of it read this
 * and nothing else. A non-finite wrap width (wrapping disabled) is passed
 * through unchanged rather than turned into a number.
 */
function blockWidth(maxWidth: number, inkWidth: number): number {
  return Number.isFinite(maxWidth) ? Math.max(maxWidth, inkWidth) : maxWidth
}

/**
 * Flattens phrasing content into an ordered list of styled text runs,
 * starting at the block's top-left corner (`cursor.y`, x = 0).
 *
 * Within one line, each run's `bbox.x` is the running horizontal cursor
 * (previous runs' widths summed), so sibling runs never overlap. A hard
 * break (mdast `break`) always resets the cursor to the block's left edge
 * and advances to a new line one `fontSizePx` down.
 *
 * Word-wrap: a chunk that would exceed `options.maxWidth` on its current line
 * is packed greedily onto successive lines at the break opportunities
 * `breakSegments` offers, and everything landing on one line is emitted as
 * ONE run. A chunk that already fits (the common case) stays a single run
 * measured once, so wrapping costs nothing for text that never overflows.
 *
 * A segment too wide for a line of its own steps down one level of
 * granularity at a time (phrase -> UAX #14 segment -> code point); only a
 * single code point wider than `maxWidth` is left to overflow, because there
 * is nothing below it to split and dropping it would be worse. Wrapping is
 * skipped entirely when `maxWidth` is non-finite or <= 0 (no meaningful width
 * to wrap against). Inline code, raw HTML, and inline math runs are atomic —
 * their source text may contain whitespace that is not a word boundary (a
 * code span's argument list, an HTML tag's attributes) — so they are always
 * emitted as one run even when they overflow.
 */
function layoutPhrasing(
  children: readonly (MdastPhrasingContent | MdastCellPhrasingContent)[],
  cursor: Cursor,
  options: ResolvedMdastOptions,
  fontSizePx: number,
  style: { emphasis?: boolean; strong?: boolean; deleted?: boolean } = {},
  lineHeightPx: number = fontSizePx * options.theme.bodyLineHeight,
): PhrasingLayout {
  const runs: TextRunNode[] = []
  const line = { x: 0, index: 0 }
  const canWrap = Number.isFinite(options.maxWidth) && options.maxWidth > 0

  const pushRun = (
    text: string,
    extra: Partial<TextRunNode>,
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
    // Inline code is measured AND declared in the mono family at its own
    // size: the measured-vs-declared invariant this file holds for body
    // runs applies just as hard to a run that changes both.
    font: { family: string; sizePx: number } = { family: options.fontFamily, sizePx: fontSizePx },
  ) => {
    const metrics = options.measure(text, bodyFont(font.family, font.sizePx, runStyle))
    const width = clampAdvance(metrics.advanceWidth)
    const baseline = clampAdvance(baselineIn(lineHeightPx, font.sizePx, metrics.ascent))
    // A run with a backdrop occupies its padding IN FLOW, exactly as CSS
    // horizontal padding does. Without this the pill is drawn wider than the
    // cursor advanced and the next run paints over its right edge — observed
    // as `layoutMdastBlocks` running into the word after it.
    const padX = isFinitePositive(extra.backdropPadXPx) ? extra.backdropPadXPx : 0
    runs.push({
      kind: 'textRun',
      bbox: {
        x: cursor.x + line.x + padX,
        y: cursor.y + line.index * lineHeightPx,
        w: width,
        h: lineHeightPx,
      },
      baseline,
      text,
      ...runStyle,
      ...extra,
      // Stamped last so nothing can emit a run declaring a family OR SIZE
      // other than the ones it was measured with (see
      // MdastLayoutOptions.fontFamily) — a run drawn at the host's inherited
      // size would render every measured wrap width wrong and flatten the
      // heading hierarchy.
      appearance: {
        ...(options.textFill !== undefined ? { fill: options.textFill } : {}),
        ...extra.appearance,
        fontFamily: font.family,
        fontSize: font.sizePx,
      },
    })
    line.x += width + 2 * padX
  }

  const wrapAndPush = (
    text: string,
    extra: Partial<TextRunNode>,
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    const widthOf = (value: string) =>
      measureRunWidth(options.measure, options.fontFamily, value, fontSizePx, runStyle)
    // Mutable: an over-wide segment is replaced IN PLACE by its code points
    // (see below), and a segment that did not fit is retried at the start of
    // the next line.
    const segments = [...breakSegments(text)]
    // Everything that lands on one line is emitted as ONE run. Emitting a run
    // per break opportunity would also fit, and would multiply the SVG's
    // <text> elements by the character count of every CJK paragraph.
    //
    // ponytail: linear scan re-measuring the whole accumulated line each
    // segment — exact, and O(line length) characters measured per segment.
    // Measured on the scoreboard corpus it costs 0.06ms -> 0.75ms for 33
    // layouts (~23us each), which is noise beside edge routing's 46-405ms per
    // canvas, so it is not worth trading exactness for yet. If text layout
    // ever shows up in a profile, binary-search the largest fitting prefix
    // instead: width is monotone in prefix length, so that is O(log segments)
    // measures per line with no loss of exactness.
    let buffered = ''
    const flush = () => {
      // Trailing whitespace is a cursor advance, never glyphs: XML strips a
      // run's boundary whitespace, so a run carrying it would paint a
      // space-width left of where layout measured it.
      //
      // `trimEnd`, not `/\s+$/`: an anchored `\s+` retries at every position
      // and is quadratic on a long whitespace run (CodeQL js/polynomial-redos,
      // high). Document text is untrusted input, so the linear form is the
      // only one worth having here even though `emit` collapses whitespace
      // before this point.
      const painted = buffered.trimEnd()
      if (painted !== '') pushRun(painted, extra, runStyle)
      buffered = ''
    }
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index] ?? ''
      const candidate = buffered + segment
      if (line.x + widthOf(candidate.trimEnd()) <= options.maxWidth) {
        buffered = candidate
        continue
      }
      if (buffered !== '' || line.x > 0) {
        flush()
        line.x = 0
        line.index += 1
        // A boundary space at the start of a line is dropped, not advanced.
        segments[index] = segment.trimStart()
        index -= 1
        continue
      }
      // Alone at the start of a line and still too wide: step down one level
      // of granularity (phrase -> UAX #14 segments -> code points). A single
      // code point wider than maxWidth is irreducible and is left to overflow
      // rather than dropped.
      const finer = finerSegments(segment)
      if (finer.length <= 1) {
        buffered = candidate
        continue
      }
      segments.splice(index, 1, ...finer)
      index -= 1
    }
    flush()
  }

  const emit = (
    text: string,
    extra: Partial<TextRunNode> = {},
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean } = style,
    // Atomic runs (inline code, raw HTML, inline math) must never be split
    // mid-token at a whitespace boundary — unlike prose, an internal space
    // in their source text is not a word boundary.
    wrappable = true,
    // Inline MATH is atomic AND uncuttable: `a + b + c` cut to `a + b`
    // reads as a complete formula that is simply wrong, where cut code or
    // cut markup reads as cut. Overflowing is the lesser harm.
    truncatable = true,
    font?: { family: string; sizePx: number },
  ) => {
    if (!wrappable) {
      // Atomic: never SPLIT, because an interior space in a code span or an
      // HTML tag is not a word boundary. Cutting it is the only way left to
      // keep it inside the box, and the run says so.
      const atomicFont = font ?? { family: options.fontFamily, sizePx: fontSizePx }
      // A backdrop's padding is part of what the run occupies, so it comes
      // out of the fit budget too — otherwise the pill is cut to the wrap
      // width and its padding paints past it.
      const padX = isFinitePositive(extra.backdropPadXPx) ? extra.backdropPadXPx : 0
      const fitted =
        canWrap && truncatable
          ? fitToWidth(
              text,
              bodyFont(atomicFont.family, atomicFont.sizePx, runStyle),
              options.measure,
              options.maxWidth - line.x - 2 * padX,
            )
          : { text }
      pushRun(
        fitted.text,
        {
          ...extra,
          ...(fitted.truncated ? { truncated: true } : {}),
          ...(fitted.overflows ? { overflows: true } : {}),
        },
        runStyle,
        atomicFont,
      )
      return
    }
    // XML — and therefore an SVG <text> element — strips leading/trailing
    // whitespace and squeezes interior whitespace sequences to one space.
    // A run's text must already be in that collapsed form, with boundary
    // whitespace carried as CURSOR ADVANCES instead of characters,
    // otherwise the painted glyphs land a space-width left of where layout
    // measured them ("`code` and" painting as "codeand"). Atomic runs above
    // are exempt: their source text is verbatim by contract.
    const collapsed = text.trim().replace(/\s+/g, ' ')
    const spaceWidth = measureRunWidth(
      options.measure,
      options.fontFamily,
      ' ',
      fontSizePx,
      runStyle,
    )
    // A boundary space at the start of a line is dropped, not advanced —
    // the same rule wrapAndPush applies to its separators.
    if (/^\s/.test(text) && line.x > 0) {
      line.x += spaceWidth
    }
    if (collapsed !== '') {
      const fullWidth = measureRunWidth(
        options.measure,
        options.fontFamily,
        collapsed,
        fontSizePx,
        runStyle,
      )
      if (canWrap && line.x + fullWidth > options.maxWidth) {
        wrapAndPush(collapsed, extra, runStyle)
      } else {
        pushRun(collapsed, extra, runStyle)
      }
    }
    if (/\s$/.test(text)) {
      line.x += spaceWidth
    }
  }

  /** Walk `nodes`, then stamp `link` provenance onto every run they produced. */
  const walkLinked = (
    nodes: readonly (MdastPhrasingContent | MdastCellPhrasingContent)[],
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
    link: LinkProvenance,
  ) => {
    const startIndex = runs.length
    walk(nodes, currentStyle)
    for (let i = startIndex; i < runs.length; i++) {
      runs[i] = { ...runs[i], link }
    }
  }

  const walk = (
    nodes: readonly (MdastPhrasingContent | MdastCellPhrasingContent)[],
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    for (const child of nodes) {
      switch (child.type) {
        case 'text':
          emit(child.value, {}, currentStyle)
          break
        case 'inlineCode':
          emit(
            child.value,
            {
              code: true,
              backdrop: panelPaint(options.theme, options.theme.panelOpacity),
              backdropPadXPx: options.theme.inlineCodePaddingXPx,
            },
            currentStyle,
            false,
            true,
            { family: options.theme.monoFontFamily, sizePx: codeFontSizePx(options.theme) },
          )
          break
        case 'break':
          line.x = 0
          line.index += 1
          break
        case 'html':
          emit(child.value, {}, currentStyle, false)
          break
        case 'emphasis':
          walk(child.children, { ...currentStyle, emphasis: true })
          break
        case 'strong':
          walk(child.children, { ...currentStyle, strong: true })
          break
        case 'delete':
          walk(child.children, { ...currentStyle, deleted: true })
          break
        case 'link': {
          const link: LinkProvenance = {
            kind: 'link',
            href: child.url,
            ...(child.title ? { title: child.title } : {}),
          }
          walkLinked(child.children, currentStyle, link)
          break
        }
        case 'linkReference': {
          const link: LinkProvenance = { kind: 'link', href: `#${child.identifier}` }
          if (child.children.length === 0) {
            emit(child.identifier, { link }, currentStyle)
          } else {
            walkLinked(child.children, currentStyle, link)
          }
          break
        }
        case 'image':
          emit(child.alt ?? '', {}, currentStyle)
          break
        case 'imageReference':
          emit(child.alt ?? child.identifier, {}, currentStyle)
          break
        case 'inlineMath':
          emit(child.value, {}, currentStyle, false, false)
          break
        case 'wikiLink':
          emit(
            child.alias ?? tryResolveTitle(options, child.documentId) ?? child.documentId,
            {
              link: {
                kind: 'wikiLink',
                documentId: child.documentId,
                ...(child.alias ? { alias: child.alias } : {}),
              },
            },
            currentStyle,
          )
          break
        case 'embed':
          // Inline (mixed into prose) an embed stays a link run; the
          // resolved title is a better label than the raw id when known.
          emit(
            tryResolveEmbed(options, child.documentId)?.title ?? child.documentId,
            { link: { kind: 'embed', documentId: child.documentId } },
            currentStyle,
          )
          break
      }
    }
  }

  walk(children, style)
  const inkWidth = runs.reduce((widest, run) => Math.max(widest, run.bbox.x + run.bbox.w), 0)
  return { runs, lineCount: line.index + 1, inkWidth }
}

/**
 * Column widths sized to CONTENT, then scaled to fit. An equal split made a
 * two-word column as wide as a sentence, which is most of why the old table
 * read as floating text rather than as a table; GitHub sizes to content the
 * same way. Scaling down (rather than clipping) keeps the table inside the
 * column, and the floor stops a scaled column from collapsing under its own
 * padding.
 */
function tableColumnWidths(
  node: Extract<MdastFlowContent, { type: 'table' }>,
  columnCount: number,
  options: ResolvedMdastOptions,
): number[] {
  const natural = Array.from({ length: columnCount }, () => 0)
  for (const row of node.children) {
    for (const [index, cell] of row.children.entries()) {
      const text = cellPlainText(cell.children)
      const ink = measureRunWidth(
        options.measure,
        options.fontFamily,
        text,
        options.theme.bodyFontSizePx,
        {
          strong: true,
        },
      )
      natural[index] = Math.max(natural[index] ?? 0, ink + 2 * options.theme.tableCellPaddingXPx)
    }
  }
  const total = natural.reduce((sum, w) => sum + w, 0)
  if (!Number.isFinite(options.maxWidth) || options.maxWidth <= 0 || total <= options.maxWidth) {
    return natural
  }
  const minimum = 2 * options.theme.tableCellPaddingXPx + options.theme.bodyFontSizePx
  const scale = options.maxWidth / total
  return natural.map((w) => Math.max(w * scale, minimum))
}

/** A cell's text with no styling, for width measurement only. */
function cellPlainText(children: readonly MdastCellPhrasingContent[]): string {
  let text = ''
  for (const child of children) {
    if ('value' in child && typeof child.value === 'string') text += child.value
    else if ('children' in child && Array.isArray(child.children)) {
      text += cellPlainText(child.children as readonly MdastCellPhrasingContent[])
    }
  }
  return text
}

/**
 * The `highlightCode` seam, guarded to the never-throw rule its siblings
 * follow. Anything unusable — a throw, `undefined`, a non-array, or a line
 * count that disagrees with the source — degrades to one plain token per
 * line, which is exactly what the block rendered before highlighting existed.
 */
function tokenizeCode(
  lang: string,
  value: string,
  lineCount: number,
  options: ResolvedMdastOptions,
): CodeTokenLines {
  const plain: CodeTokenLines = value.split('\n').map((text) => [{ text }])
  if (options.highlightCode === undefined) return plain
  let tokenized: CodeTokenLines | undefined
  try {
    tokenized = options.highlightCode(lang, value)
  } catch {
    return plain
  }
  if (!Array.isArray(tokenized) || tokenized.length !== lineCount) return plain
  return tokenized.every((line) => Array.isArray(line)) ? tokenized : plain
}

function layoutBlock(
  node: MdastFlowContent,
  cursor: Cursor,
  options: ResolvedMdastOptions,
  depth: number,
  // canvasIds of the embeds currently being laid out on THIS recursion
  // path — the embed-recursion cycle/cap contract, threaded rather than
  // stored on options so sibling embeds never see each other.
  embedPath: readonly string[] = [],
): SceneNode {
  switch (node.type) {
    case 'heading': {
      // A heading belongs to what FOLLOWS it, so it takes more air above
      // than below — the asymmetry is what makes a long body scan as
      // sections. Not applied to a leading heading, which would otherwise
      // start the body with a blank band.
      if (cursor.y > 0) cursor.y += options.theme.headingSpaceAbovePx
      const fontSizePx = options.theme.headingFontSizePx[node.depth]
      const lineHeightPx = fontSizePx * options.theme.headingLineHeight
      const { runs, lineCount, inkWidth } = layoutPhrasing(
        node.children,
        cursor,
        options,
        fontSizePx,
        {},
        lineHeightPx,
      )
      const height = lineCount * lineHeightPx
      const heading: HeadingBlockNode = {
        kind: 'heading',
        bbox: { x: cursor.x, y: cursor.y, w: blockWidth(options.maxWidth, inkWidth), h: height },
        level: node.depth,
        runs,
      }
      cursor.y += height + options.theme.blockGapPx
      return heading
    }
    case 'paragraph': {
      // A paragraph that IS an embed (its sole child) renders the target's
      // body as a block; an embed mixed into prose stays an inline run.
      const only = node.children.length === 1 ? node.children[0] : undefined
      if (only?.type === 'embed' && options.resolveEmbed !== undefined) {
        return layoutEmbedBlock(only.documentId, cursor, options, embedPath)
      }
      const { runs, lineCount, inkWidth } = layoutPhrasing(
        node.children,
        cursor,
        options,
        options.theme.bodyFontSizePx,
      )
      const height = lineCount * bodyLineHeightPx(options.theme)
      const paragraph: ParagraphBlockNode = {
        kind: 'paragraph',
        bbox: { x: cursor.x, y: cursor.y, w: blockWidth(options.maxWidth, inkWidth), h: height },
        runs,
      }
      cursor.y += height + options.theme.blockGapPx
      return paragraph
    }
    case 'blockquote': {
      const startY = cursor.y
      const startX = cursor.x
      const indent = options.theme.blockquoteBarWidthPx + options.theme.blockquoteGapPx
      const indented: ResolvedMdastOptions = { ...options, maxWidth: options.maxWidth - indent }
      cursor.x = startX + indent
      const quoted = node.children.map((child) =>
        layoutBlock(child, cursor, indented, depth, embedPath),
      )
      cursor.x = startX
      // The last quoted block left a trailing block gap INSIDE the quote;
      // the bar and the box end at the content, and the gap belongs after.
      const contentEnd = cursor.y - options.theme.blockGapPx
      const bar: ShapeSceneNode = {
        kind: 'shape',
        bbox: {
          x: startX,
          y: startY,
          w: options.theme.blockquoteBarWidthPx,
          h: Math.max(contentEnd - startY, 0),
        },
        radius: options.theme.blockquoteBarWidthPx / 2,
        appearance: panelPaint(options.theme, options.theme.borderOpacity),
      }
      const quote: BlockquoteNode = {
        kind: 'blockquote',
        bbox: { x: startX, y: startY, w: options.maxWidth, h: Math.max(contentEnd - startY, 0) },
        children: [bar, ...quoted],
        appearance: { fillOpacity: options.theme.mutedTextOpacity },
      }
      return quote
    }
    case 'list': {
      const startY = cursor.y
      const ordered = node.ordered ?? false
      const items: ListItemNode[] = node.children.map((item, index) =>
        layoutListItem(
          item,
          ordered ? (node.start ?? 1) + index : undefined,
          cursor,
          options,
          depth + 1,
          embedPath,
        ),
      )
      // `layoutListItem` closes each item with the tighter intra-list gap;
      // the list as a whole is still followed by a full block gap.
      cursor.y += options.theme.blockGapPx - options.theme.listItemGapPx
      const list: ListBlockNode = {
        kind: 'list',
        bbox: {
          x: cursor.x,
          y: startY,
          w: options.maxWidth,
          h: cursor.y - startY - options.theme.blockGapPx,
        },
        ordered,
        depth,
        items,
      }
      return list
    }
    case 'code': {
      if (node.lang) {
        let rendered: string | RenderedSvgFragment | undefined
        try {
          rendered = options.renderDiagram?.(node.lang, node.value)
        } catch {
          rendered = undefined
        }
        if (rendered !== undefined) {
          return placeFragment(rendered, cursor, options)
        }
      }
      const lines = node.value.split('\n')
      const height =
        lines.length * codeLineHeightPx(options.theme) + 2 * options.theme.codeBlockPaddingPx
      const font = bodyFont(options.theme.monoFontFamily, codeFontSizePx(options.theme))
      // One run per SOURCE line. A single `<text>` carrying the whole fence
      // paints it on one line — SVG collapses the newlines — so the code ran
      // off the right edge of a box sized for every line.
      // A code line never wraps — its indentation and its identity as one
      // source line are the point — so the only way to keep it inside the
      // panel is to cut it, exactly as an atomic inline run is cut.
      const innerWidth = options.maxWidth - 2 * options.theme.codeBlockPaddingPx
      const tokenLines = tokenizeCode(node.lang ?? '', node.value, lines.length, options)
      const runs: TextRunNode[] = tokenLines.flatMap((tokens, index) => {
        const y =
          cursor.y + options.theme.codeBlockPaddingPx + index * codeLineHeightPx(options.theme)
        const baselineOf = (ascent: number) =>
          clampAdvance(
            baselineIn(codeLineHeightPx(options.theme), codeFontSizePx(options.theme), ascent),
          )
        const out: TextRunNode[] = []
        let x = 0
        for (const token of tokens) {
          // The line's budget is shared across its tokens: fitting each one
          // against the full width would let a highlighted line run out of
          // the panel that a plain one is cut to stay inside.
          const fitted = fitToWidth(token.text, font, options.measure, innerWidth - x)
          if (fitted.text === '') break
          const metrics = options.measure(fitted.text, font)
          const fill = token.role !== undefined ? options.syntax?.[token.role] : undefined
          out.push({
            kind: 'textRun' as const,
            bbox: {
              x: cursor.x + options.theme.codeBlockPaddingPx + x,
              y,
              w: clampAdvance(metrics.advanceWidth),
              h: codeLineHeightPx(options.theme),
            },
            baseline: baselineOf(metrics.ascent),
            text: fitted.text,
            code: true,
            ...(fitted.truncated ? { truncated: true as const } : {}),
            ...(fitted.overflows ? { overflows: true as const } : {}),
            appearance: {
              ...(options.textFill !== undefined ? { fill: options.textFill } : {}),
              ...(fill !== undefined ? { fill } : {}),
              fontFamily: options.theme.monoFontFamily,
              fontSize: codeFontSizePx(options.theme),
            },
          })
          x += clampAdvance(metrics.advanceWidth)
          // Either flag means the line's remaining width is spent: a token
          // kept past `innerWidth` leaves the next `innerWidth - x` negative,
          // which `fitToWidth` reads as "no width to fit against" and answers
          // by returning the WHOLE token uncut, straight past the panel.
          if (fitted.truncated || fitted.overflows) break
        }
        return out
      })
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        bbox: { x: cursor.x, y: cursor.y, w: options.maxWidth, h: height },
        value: node.value,
        ...(node.lang ? { lang: node.lang } : {}),
        runs,
        appearance: panelPaint(options.theme, options.theme.panelOpacity),
        radius: options.theme.cornerRadiusPx,
      }
      cursor.y += height + options.theme.blockGapPx
      return code
    }
    case 'html': {
      const rawHtml: RawHtmlNode = {
        kind: 'rawHtml',
        bbox: { x: cursor.x, y: cursor.y, w: options.maxWidth, h: bodyLineHeightPx(options.theme) },
        value: node.value,
      }
      cursor.y += bodyLineHeightPx(options.theme) + options.theme.blockGapPx
      return rawHtml
    }
    case 'thematicBreak': {
      const hr: ThematicBreakNode = {
        kind: 'thematicBreak',
        bbox: {
          x: cursor.x,
          y: cursor.y,
          w: options.maxWidth,
          h: options.theme.thematicBreakHeightPx,
        },
        appearance: panelPaint(options.theme, options.theme.borderOpacity),
      }
      cursor.y += options.theme.thematicBreakHeightPx + options.theme.blockGapPx
      return hr
    }
    case 'definition': {
      // mdast definitions carry no visual content of their own (GFM
      // reference-link targets are resolved into linkReference/
      // imageReference runs elsewhere); emitting a zero-height marker keeps
      // the node present in the scene graph for provenance without
      // consuming layout space.
      const marker: UnresolvedReferenceNode = {
        kind: 'unresolvedReference',
        bbox: { x: 0, y: cursor.y, w: 0, h: 0 },
        identifier: node.identifier,
      }
      return marker
    }
    case 'table': {
      const startY = cursor.y
      const columnCount = Math.max(...node.children.map((row) => row.children.length), 1)
      const columnWidths = tableColumnWidths(node, columnCount, options)
      const tableWidth = columnWidths.reduce((total, w) => total + w, 0)
      const rows: TableRowSceneNode[] = node.children.map((row, rowIndex) => {
        const rowY = cursor.y
        // The first mdast table row IS the header; GitHub bolds it and
        // starts its zebra on the row after, so the parity check counts
        // from the header exactly as `tr:nth-child(2n)` does.
        const header = rowIndex === 0
        const last = rowIndex === node.children.length - 1
        let x = cursor.x
        // Cells are laid out BEFORE the row has a height: a column narrow
        // enough to wrap its content is reachable (tableColumnWidths scales
        // columns down to fit), and a row fixed at one line box would paint
        // the overflow across the row below it.
        const laid = row.children.map((cell, cellIndex) => {
          const width = columnWidths[cellIndex] ?? 0
          const cellX = x
          x += width
          const { runs, lineCount } = layoutPhrasing(
            cell.children,
            { y: rowY + options.theme.tableCellPaddingYPx, x: options.theme.tableCellPaddingXPx },
            { ...options, maxWidth: width - 2 * options.theme.tableCellPaddingXPx },
            options.theme.bodyFontSizePx,
            header ? { strong: true } : {},
          )
          return { cellX, width, runs, lineCount }
        })
        const rowHeight =
          Math.max(...laid.map((cell) => cell.lineCount), 1) * bodyLineHeightPx(options.theme) +
          2 * options.theme.tableCellPaddingYPx
        const cells: TableCellSceneNode[] = laid.map((cell) => ({
          kind: 'tableCell',
          bbox: { x: cell.cellX, y: rowY, w: cell.width, h: rowHeight },
          runs: cell.runs,
        }))
        cursor.y += rowHeight
        return {
          kind: 'tableRow',
          bbox: { x: cursor.x, y: rowY, w: tableWidth, h: rowHeight },
          cells,
          ...(header ? { header: true } : {}),
          ...(last ? {} : { appearance: panelPaint(options.theme, options.theme.borderOpacity) }),
        }
      })
      cursor.y += options.theme.blockGapPx
      const table: TableBlockNode = {
        kind: 'table',
        bbox: {
          x: cursor.x,
          y: startY,
          w: tableWidth,
          h: cursor.y - startY - options.theme.blockGapPx,
        },
        rows,
      }
      return table
    }
    case 'math': {
      const renderMath = options.renderMath ?? defaultRenderMath
      let rendered: string | RenderedSvgFragment
      try {
        // A throwing renderer degrades this one node to the placeholder
        // (total-layout rule), exactly like renderDiagram above.
        rendered = renderMath(node.value, true) ?? defaultRenderMath(node.value)
      } catch {
        rendered = defaultRenderMath(node.value)
      }
      if (typeof rendered !== 'string') {
        return placeFragment(rendered, cursor, options)
      }
      const height = node.value.split('\n').length * codeLineHeightPx(options.theme)
      const fragment: SvgFragmentNode = {
        kind: 'svgFragment',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: height },
        svg: rendered,
      }
      cursor.y += height + options.theme.blockGapPx
      return fragment
    }
  }
}

/**
 * Places a renderer-supplied SVG fragment at the cursor, sized from the
 * dimensions the renderer reported. Width clamps to the column; a missing
 * or non-finite dimension falls back to the column width / one code line,
 * keeping layout total against a renderer that reports garbage.
 */
function placeFragment(
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

function layoutListItem(
  item: MdastListItem,
  ordinal: number | undefined,
  cursor: Cursor,
  options: ResolvedMdastOptions,
  depth: number,
  embedPath: readonly string[],
): ListItemNode {
  const startY = cursor.y
  const indented: ResolvedMdastOptions = {
    ...options,
    maxWidth: options.maxWidth - options.theme.listIndentPx,
  }
  const children: (ListItemNode['children'][number] | TextRunNode)[] = item.children.map((child) =>
    layoutBlock(child, cursor, indented, depth, embedPath),
  )
  // The marker glyph (bullet or ordinal). Wrapper-RELATIVE like every other
  // child (the listItem renderer translates by its own bbox.x), so the
  // gutter to the left of the content is negative x. Checked task items
  // keep provenance only — a checkbox affordance is a separate feature,
  // and drawing a bullet next to it would double the glyphs.
  if (item.checked === null || item.checked === undefined) {
    const markerText = ordinal !== undefined ? `${ordinal}.` : '\u2022'
    const metrics = options.measure(
      markerText,
      bodyFont(options.fontFamily, options.theme.bodyFontSizePx),
    )
    const markerWidth = clampAdvance(metrics.advanceWidth)
    children.unshift({
      kind: 'textRun',
      bbox: {
        // Right-aligned against the content edge, not parked at the far side
        // of the gutter — see `listMarkerGapPx`.
        x: -(markerWidth + options.theme.listMarkerGapPx),
        y: startY,
        w: markerWidth,
        h: bodyLineHeightPx(options.theme),
      },
      baseline: clampAdvance(
        baselineIn(bodyLineHeightPx(options.theme), options.theme.bodyFontSizePx, metrics.ascent),
      ),
      text: markerText,
      appearance: {
        ...(options.textFill !== undefined ? { fill: options.textFill } : {}),
        fontFamily: options.fontFamily,
        fontSize: options.theme.bodyFontSizePx,
      },
    })
  }
  // Prose blocks each close with a full block gap; inside a list that reads
  // as items drifting apart, so the item's own trailing gap is tightened.
  cursor.y -= options.theme.blockGapPx - options.theme.listItemGapPx
  return {
    kind: 'listItem',
    bbox: {
      x: options.theme.listIndentPx * depth,
      y: startY,
      w: options.maxWidth - options.theme.listIndentPx * depth,
      h: cursor.y - startY,
    },
    ...(ordinal !== undefined ? { ordinal } : {}),
    ...(item.checked !== null && item.checked !== undefined ? { checked: item.checked } : {}),
    children,
  }
}

/**
 * Lays out one block-level embed: the resolved target's blocks render
 * inline under an `embedResolved` node whose children stay in ABSOLUTE
 * coordinates (no SVG transform, so the listItem/tableCell transform-
 * boundary set is untouched). Total by construction: a cycle on the
 * current path, the depth cap, and a missing/throwing resolver each
 * degrade to an `embedPlaceholder` with the matching reason — mirroring
 * embed-recursion.ts's contract — so no resolver can loop or abort layout.
 */
function layoutEmbedBlock(
  documentId: string,
  cursor: Cursor,
  options: ResolvedMdastOptions,
  embedPath: readonly string[],
): EmbedResolvedNode | EmbedPlaceholderNode {
  const startY = cursor.y
  const resolved = tryResolveEmbed(options, documentId)
  const placeholder = (reason: EmbedPlaceholderNode['reason']): EmbedPlaceholderNode => {
    const node: EmbedPlaceholderNode = {
      kind: 'embedPlaceholder',
      bbox: { x: 0, y: startY, w: options.maxWidth, h: options.theme.bodyFontSizePx },
      documentId,
      title: resolved?.title ?? documentId,
      reason,
    }
    cursor.y += options.theme.bodyFontSizePx + options.theme.blockGapPx
    return node
  }
  if (embedPath.includes(documentId)) return placeholder('cycle')
  if (embedPath.length >= EMBED_DEPTH_CAP) return placeholder('depthCap')
  if (resolved === undefined) return placeholder('unresolvable')
  const nextPath = [...embedPath, documentId]
  if ('canvas' in resolved) {
    if (options.layoutEmbeddedCanvas === undefined) return placeholder('unresolvable')
    return layoutCanvasEmbedBlock(documentId, resolved.canvas, cursor, options, nextPath)
  }
  const children = resolved.root.children.map((child) =>
    layoutBlock(child, cursor, options, 0, nextPath),
  )
  return {
    kind: 'embedResolved',
    bbox: { x: 0, y: startY, w: options.maxWidth, h: cursor.y - startY },
    documentId,
    children,
  }
}

/**
 * The tallest a canvas miniature gets, as a share of its width: a canvas is
 * scaled to the column, and a tall one is scaled further so one embed cannot
 * push the rest of the page below the fold. 4:3 rather than 16:9 because a
 * canvas grows in both directions and a wide cap crops the vertical one
 * first.
 */
const CANVAS_EMBED_MAX_ASPECT = 3 / 4

/**
 * A canvas-targeted embed: a panel in the code block's chrome, the target's
 * name as a link along its top (the same run an inline embed emits, so the
 * name comes from the one resolver and the link opens the canvas), and the
 * composer's miniature fitted underneath. The frame is drawn under
 * `embedResolved` rather than as a sibling so the rail, the digest and every
 * scene transform keep seeing ONE block for one embed.
 */
function layoutCanvasEmbedBlock(
  documentId: string,
  canvas: SpatialCanvas,
  cursor: Cursor,
  options: ResolvedMdastOptions,
  embedPath: readonly string[],
): EmbedResolvedNode {
  const startX = cursor.x
  const startY = cursor.y
  const pad = options.theme.codeBlockPaddingPx
  cursor.x = startX + pad
  cursor.y = startY + pad
  const title = layoutPhrasing(
    [{ type: 'embed', documentId }],
    cursor,
    options,
    options.theme.bodyFontSizePx,
  )
  cursor.x = startX
  const titleHeight = title.lineCount * bodyLineHeightPx(options.theme)
  const innerWidth = Math.max(0, options.maxWidth - 2 * pad)
  const box: EmbeddedCanvasBox = {
    x: startX + pad,
    y: startY + pad + titleHeight + pad,
    maxWidth: innerWidth,
    maxHeight: innerWidth * CANVAS_EMBED_MAX_ASPECT,
    embedPath,
  }
  let miniature: EmbeddedCanvasMiniature | undefined
  try {
    miniature = options.layoutEmbeddedCanvas?.(canvas, box)
  } catch {
    miniature = undefined
  }
  // An empty or unfittable canvas leaves the panel at the title's height;
  // the second pad is the gap above a miniature, so it is only paid for one.
  const contentBottom = miniature === undefined ? startY + pad + titleHeight : box.y + miniature.h
  const height = contentBottom + pad - startY
  const frame: ShapeSceneNode = {
    kind: 'shape',
    bbox: { x: startX, y: startY, w: options.maxWidth, h: height },
    radius: options.theme.cornerRadiusPx,
    appearance: panelPaint(options.theme, options.theme.panelOpacity),
  }
  cursor.y = startY + height + options.theme.blockGapPx
  return {
    kind: 'embedResolved',
    bbox: { x: startX, y: startY, w: options.maxWidth, h: height },
    documentId,
    children: [frame, ...title.runs, ...(miniature?.nodes ?? [])],
  }
}

/**
 * The single mdast -> scene-graph render path. The exact same function
 * feeds preview, a spatial text node host, and export — there is no
 * separate HTML renderer.
 */
export function layoutMdastBlocks(root: MdastRoot, options: MdastLayoutOptions): Scene {
  const cursor: Cursor = { y: 0, x: 0 }
  const resolved = resolveTheme(options)
  const nodes = root.children.map((child) =>
    layoutBlock(child, cursor, resolved, 0, options.embedPath ?? []),
  )
  return { nodes }
}

/**
 * Every function below reads `theme` unconditionally, so it is resolved once at
 * the entry rather than defaulted at each of forty reference sites — the same
 * shape `layoutSpatialCanvas` uses for `parseBody`.
 */
export function resolveTheme(options: MdastLayoutOptions): ResolvedMdastOptions {
  return { ...options, theme: options.theme ?? MARKDOWN_THEME_NODE }
}

/** `MdastLayoutOptions` after `resolveTheme` — `theme` is no longer optional. */
export type ResolvedMdastOptions = MdastLayoutOptions & { readonly theme: MarkdownTheme }

export interface FittedBlocks {
  readonly nodes: readonly SceneNode[]
  /** Something a reader cannot see was removed to make the rest fit. */
  readonly truncated: boolean
  /**
   * The content does not fit the box, whether or not anything was removed:
   * `truncated`, or a run kept at a width it exceeds because it is one
   * irreducible code point. The weaker claim, and the one an agent reads.
   */
  readonly overflows: boolean
}

/**
 * Marks the LAST run in paint order, which is the one thing a reader can see
 * next to whatever was removed.
 *
 * Rebuilds only the spine down to that run — every bbox is left exactly as
 * laid out, so the wrapper-relative x convention (`subtreeOffsetX`) is
 * untouched.
 */
function markLastRun(nodes: readonly SceneNode[]): readonly SceneNode[] {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index] as SceneNode & {
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
      items?: readonly SceneNode[]
    }
    if (node.kind === 'textRun') {
      const copy = [...nodes]
      copy[index] = { ...node, truncated: true as const }
      return copy
    }
    for (const key of ['runs', 'children', 'items'] as const) {
      const branch = node[key]
      if (branch === undefined || branch.length === 0) continue
      const marked = markLastRun(branch)
      if (marked !== branch) {
        const copy = [...nodes]
        copy[index] = { ...node, [key]: marked } as SceneNode
        return copy
      }
    }
  }
  return nodes
}

/**
 * Trims laid-out blocks to what fits `maxHeight`, and says whether anything
 * was removed.
 *
 * Granularity steps down the way the wrap does: whole blocks first, then the
 * LINES of the block that straddles the edge (`layoutPhrasing` emits one run
 * per wrapped line) or the ITEMS of a list. Whole-block alone leaves the
 * commonest body of all unbounded — a single long paragraph is ONE block, so
 * it either fits or is kept whole and painted outside its box.
 *
 * `blockquote`/`table`/`code` stay whole-block: their children are not lines,
 * and two of them are the `subtreeOffsetX` transform-boundary class.
 *
 * This lives here rather than beside the spatial fitter that calls it because
 * "which part of a block is a line" is this module's own knowledge — the
 * caller supplies a height and learns nothing about block internals.
 */
export function fitBlocksToHeight(nodes: readonly SceneNode[], maxHeight: number): FittedBlocks {
  const kept: SceneNode[] = []
  let truncated = false
  for (const entry of nodes) {
    // `layoutMdastBlocks` never emits an edge (the one variant with no
    // `bbox`); that guard is for the type checker, not runtime.
    if (entry.kind === 'edge') continue
    if (entry.bbox.y + entry.bbox.h <= maxHeight) {
      kept.push(entry)
      continue
    }
    // The first block that does not fit is the last one considered: blocks
    // are laid out with strictly increasing bottoms, so everything after it
    // starts lower still.
    const trimmed = trimBlock(entry, maxHeight)
    if (trimmed !== undefined) kept.push(trimmed)
    truncated = true
    break
  }
  if (kept.length < nodes.length) truncated = true
  // A run cut sideways is content the reader cannot see, exactly like a
  // dropped block — an atomic inline run or a code line, neither of which can
  // wrap. Counted here rather than at each producer so every caller of this
  // one seam reports it, and only vertical loss needs `markLastRun`: a cut
  // run is already its own visible signal.
  const nodesToKeep = truncated ? markLastRun(kept) : kept
  return {
    nodes: nodesToKeep,
    truncated: truncated || someRun(nodesToKeep, (run) => run.truncated === true),
    overflows:
      truncated || someRun(nodesToKeep, (run) => run.truncated === true || run.overflows === true),
  }
}

/** Whether any run anywhere under `nodes` satisfies `predicate`. */
function someRun(nodes: readonly SceneNode[], predicate: (run: TextRunNode) => boolean): boolean {
  return nodes.some((node) => {
    if (node.kind === 'edge') return false
    if (node.kind === 'textRun') return predicate(node)
    const branching = node as SceneNode & {
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
      items?: readonly SceneNode[]
      cells?: readonly SceneNode[]
      rows?: readonly SceneNode[]
    }
    return (['runs', 'children', 'items', 'cells', 'rows'] as const).some((key) => {
      const branch = branching[key]
      return branch !== undefined && someRun(branch, predicate)
    })
  })
}

/**
 * The smallest non-empty rendering of `nodes`: the first block cut to its
 * FIRST LINE. This is keep-first's unit, and it has to be a line for the same
 * reason `fitBlocksToHeight` steps down to lines — "a text node never renders
 * empty" must not quietly mean "renders its whole first block, however tall".
 *
 * The hole this closes was only reachable once a line box grew past its font
 * size: while one line always fit the smallest box anyone used, nothing ever
 * asked for a fallback below block granularity. A caller keeping the first
 * BLOCK painted a two-line paragraph inside a one-line box AND reported
 * `truncated: false`, because it counted blocks and the paragraph was one —
 * so an agent reading `wb_scene_digest` was told nothing was hidden while the
 * frame was visibly overflowing.
 *
 * Blocks whose children are not lines (`blockquote`/`table`/`code`, the
 * `subtreeOffsetX` transform-boundary class) are kept whole, exactly as
 * `trimBlock` keeps them.
 */
export function firstLineOfBlocks(nodes: readonly SceneNode[]): FittedBlocks {
  const first = nodes[0]
  if (first === undefined || first.kind === 'edge')
    return { nodes: [], truncated: false, overflows: false }
  const cut = firstLineOfBlock(first)
  const truncated = nodes.length > 1 || cut.dropped
  const kept = truncated ? markLastRun([cut.node]) : [cut.node]
  return {
    nodes: kept,
    truncated,
    overflows: truncated || someRun(kept, (run) => run.overflows === true),
  }
}

function firstLineOfBlock(block: Exclude<SceneNode, { kind: 'edge' }>): {
  node: SceneNode
  dropped: boolean
} {
  if (block.kind === 'list') {
    const first = block.items[0]
    if (first === undefined) return { node: block, dropped: false }
    return {
      node: {
        ...block,
        items: [first],
        bbox: { ...block.bbox, h: first.bbox.y + first.bbox.h - block.bbox.y },
      },
      dropped: block.items.length > 1,
    }
  }
  if (block.kind !== 'paragraph' && block.kind !== 'heading') return { node: block, dropped: false }
  const head = block.runs[0]
  if (head === undefined) return { node: block, dropped: false }
  // Runs sharing a `bbox.y` are one wrapped line — a line can be several runs
  // when styling changes mid-line.
  const runs = block.runs.filter((run) => run.bbox.y === head.bbox.y)
  return {
    node: {
      ...block,
      runs,
      bbox: { ...block.bbox, h: head.bbox.y + head.bbox.h - block.bbox.y },
    },
    dropped: runs.length < block.runs.length,
  }
}

function trimBlock(
  block: Exclude<SceneNode, { kind: 'edge' }>,
  maxBottom: number,
): SceneNode | undefined {
  if (block.kind === 'list') {
    const items = block.items.filter((item) => item.bbox.y + item.bbox.h <= maxBottom)
    if (items.length === 0) return undefined
    const bottom = Math.max(...items.map((item) => item.bbox.y + item.bbox.h))
    return { ...block, items, bbox: { ...block.bbox, h: bottom - block.bbox.y } }
  }
  if (block.kind !== 'paragraph' && block.kind !== 'heading') return undefined
  const runs = block.runs.filter((run) => run.bbox.y + run.bbox.h <= maxBottom)
  if (runs.length === 0) return undefined
  const bottom = Math.max(...runs.map((run) => run.bbox.y + run.bbox.h))
  return { ...block, runs, bbox: { ...block.bbox, h: bottom - block.bbox.y } }
}
