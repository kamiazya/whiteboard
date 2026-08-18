import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { LineBreaker } from 'css-line-break'
import type { MeasureText } from '../measure.js'
import { clampAdvance } from '../measure.js'
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
} from '../scene-graph.js'
import { escapeXmlText } from '../svg/format.js'
import { GITHUB_MARKDOWN_THEME } from '../theme/markdown-theme.js'
import { jaModel } from '../vendor/budoux/ja-model.js'
import { Parser } from '../vendor/budoux/parser.js'
import { fitToWidth } from './truncate.js'

/**
 * Every layout constant comes from ONE theme object (theme/markdown-theme.ts),
 * calibrated to GitHub's rendered-markdown surface. Read once here so the
 * rest of the file reads as geometry rather than as a table of numbers, and
 * so restyling stays a data change.
 */
const T = GITHUB_MARKDOWN_THEME
const HEADING_FONT_SIZE_PX = T.headingFontSizePx
export const BODY_FONT_SIZE_PX = T.bodyFontSizePx
const BLOCK_GAP_PX = T.blockGapPx
const LIST_INDENT_PX = T.listIndentPx
const BODY_LINE_HEIGHT_PX = T.bodyFontSizePx * T.bodyLineHeight
const CODE_FONT_SIZE_PX = T.bodyFontSizePx * T.codeFontScale
const CODE_LINE_HEIGHT_PX = CODE_FONT_SIZE_PX * T.codeLineHeight
const THEMATIC_BREAK_HEIGHT_PX = T.thematicBreakHeightPx

/** Chrome drawn as a filled panel (code backgrounds, table stripes). */
function panelPaint(opacity: number): Appearance {
  return { fill: T.chromeColor, fillOpacity: opacity }
}

/** Chrome drawn as a stroked outline (table cell borders). */
function borderPaint(): Appearance {
  return {
    fill: 'none',
    stroke: T.chromeColor,
    strokeOpacity: T.borderOpacity,
    strokeWidth: T.borderWidthPx,
  }
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
  readonly resolveEmbed?: (
    documentId: string,
  ) => { readonly title?: string; readonly root: MdastRoot } | undefined
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

/** Root depth is 0; mirrors embed-recursion.ts's cap and cycle semantics. */
const EMBED_DEPTH_CAP = 3

/** `resolveEmbed` guarded to the never-throw rule. */
function tryResolveEmbed(
  options: MdastLayoutOptions,
  documentId: string,
): { readonly title?: string; readonly root: MdastRoot } | undefined {
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
  options: MdastLayoutOptions,
  fontSizePx: number,
  style: { emphasis?: boolean; strong?: boolean; deleted?: boolean } = {},
  lineHeightPx: number = fontSizePx * T.bodyLineHeight,
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
      appearance: { ...extra.appearance, fontFamily: font.family, fontSize: font.sizePx },
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
        { ...extra, ...(fitted.truncated ? { truncated: true } : {}) },
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
              backdrop: panelPaint(T.panelOpacity),
              backdropPadXPx: T.inlineCodePaddingXPx,
            },
            currentStyle,
            false,
            true,
            { family: T.monoFontFamily, sizePx: CODE_FONT_SIZE_PX },
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
            child.alias ?? child.documentId,
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
  options: MdastLayoutOptions,
): number[] {
  const natural = Array.from({ length: columnCount }, () => 0)
  for (const row of node.children) {
    for (const [index, cell] of row.children.entries()) {
      const text = cellPlainText(cell.children)
      const ink = measureRunWidth(options.measure, options.fontFamily, text, BODY_FONT_SIZE_PX, {
        strong: true,
      })
      natural[index] = Math.max(natural[index] ?? 0, ink + 2 * T.tableCellPaddingXPx)
    }
  }
  const total = natural.reduce((sum, w) => sum + w, 0)
  if (!Number.isFinite(options.maxWidth) || options.maxWidth <= 0 || total <= options.maxWidth) {
    return natural
  }
  const minimum = 2 * T.tableCellPaddingXPx + BODY_FONT_SIZE_PX
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

function layoutBlock(
  node: MdastFlowContent,
  cursor: Cursor,
  options: MdastLayoutOptions,
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
      if (cursor.y > 0) cursor.y += T.headingSpaceAbovePx
      const fontSizePx = HEADING_FONT_SIZE_PX[node.depth]
      const lineHeightPx = fontSizePx * T.headingLineHeight
      const { runs, lineCount, inkWidth } = layoutPhrasing(
        node.children,
        cursor,
        options,
        fontSizePx,
        {},
        lineHeightPx,
      )
      const ruled = T.ruledHeadingLevels.includes(node.depth)
      // GitHub's `padding-bottom: .3em` between the text and the rule.
      const rulePadPx = ruled ? fontSizePx * 0.3 + T.borderWidthPx : 0
      const height = lineCount * lineHeightPx + rulePadPx
      const heading: HeadingBlockNode = {
        kind: 'heading',
        bbox: { x: cursor.x, y: cursor.y, w: blockWidth(options.maxWidth, inkWidth), h: height },
        level: node.depth,
        runs,
        ...(ruled ? { rule: { h: T.borderWidthPx, appearance: panelPaint(T.borderOpacity) } } : {}),
      }
      cursor.y += height + BLOCK_GAP_PX
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
        BODY_FONT_SIZE_PX,
      )
      const height = lineCount * BODY_LINE_HEIGHT_PX
      const paragraph: ParagraphBlockNode = {
        kind: 'paragraph',
        bbox: { x: cursor.x, y: cursor.y, w: blockWidth(options.maxWidth, inkWidth), h: height },
        runs,
      }
      cursor.y += height + BLOCK_GAP_PX
      return paragraph
    }
    case 'blockquote': {
      const startY = cursor.y
      const startX = cursor.x
      const indent = T.blockquoteBarWidthPx + T.blockquoteGapPx
      const indented: MdastLayoutOptions = { ...options, maxWidth: options.maxWidth - indent }
      cursor.x = startX + indent
      const quoted = node.children.map((child) =>
        layoutBlock(child, cursor, indented, depth, embedPath),
      )
      cursor.x = startX
      // The last quoted block left a trailing block gap INSIDE the quote;
      // the bar and the box end at the content, and the gap belongs after.
      const contentEnd = cursor.y - BLOCK_GAP_PX
      const bar: ShapeSceneNode = {
        kind: 'shape',
        bbox: {
          x: startX,
          y: startY,
          w: T.blockquoteBarWidthPx,
          h: Math.max(contentEnd - startY, 0),
        },
        radius: T.blockquoteBarWidthPx / 2,
        appearance: panelPaint(T.borderOpacity),
      }
      const quote: BlockquoteNode = {
        kind: 'blockquote',
        bbox: { x: startX, y: startY, w: options.maxWidth, h: Math.max(contentEnd - startY, 0) },
        children: [bar, ...quoted],
        appearance: { fillOpacity: T.mutedTextOpacity },
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
      cursor.y += BLOCK_GAP_PX - T.listItemGapPx
      const list: ListBlockNode = {
        kind: 'list',
        bbox: { x: cursor.x, y: startY, w: options.maxWidth, h: cursor.y - startY - BLOCK_GAP_PX },
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
      const height = lines.length * CODE_LINE_HEIGHT_PX + 2 * T.codeBlockPaddingPx
      const font = bodyFont(T.monoFontFamily, CODE_FONT_SIZE_PX)
      // One run per SOURCE line. A single `<text>` carrying the whole fence
      // paints it on one line — SVG collapses the newlines — so the code ran
      // off the right edge of a box sized for every line.
      const runs: TextRunNode[] = lines.map((text, index) => {
        const metrics = options.measure(text, font)
        return {
          kind: 'textRun' as const,
          bbox: {
            x: cursor.x + T.codeBlockPaddingPx,
            y: cursor.y + T.codeBlockPaddingPx + index * CODE_LINE_HEIGHT_PX,
            w: clampAdvance(metrics.advanceWidth),
            h: CODE_LINE_HEIGHT_PX,
          },
          baseline: clampAdvance(
            baselineIn(CODE_LINE_HEIGHT_PX, CODE_FONT_SIZE_PX, metrics.ascent),
          ),
          text,
          code: true,
          appearance: { fontFamily: T.monoFontFamily, fontSize: CODE_FONT_SIZE_PX },
        }
      })
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        bbox: { x: cursor.x, y: cursor.y, w: options.maxWidth, h: height },
        value: node.value,
        ...(node.lang ? { lang: node.lang } : {}),
        runs,
        appearance: panelPaint(T.panelOpacity),
        radius: T.cornerRadiusPx,
      }
      cursor.y += height + BLOCK_GAP_PX
      return code
    }
    case 'html': {
      const rawHtml: RawHtmlNode = {
        kind: 'rawHtml',
        bbox: { x: cursor.x, y: cursor.y, w: options.maxWidth, h: BODY_LINE_HEIGHT_PX },
        value: node.value,
      }
      cursor.y += BODY_LINE_HEIGHT_PX + BLOCK_GAP_PX
      return rawHtml
    }
    case 'thematicBreak': {
      const hr: ThematicBreakNode = {
        kind: 'thematicBreak',
        bbox: { x: cursor.x, y: cursor.y, w: options.maxWidth, h: THEMATIC_BREAK_HEIGHT_PX },
        appearance: panelPaint(T.borderOpacity),
      }
      cursor.y += THEMATIC_BREAK_HEIGHT_PX + BLOCK_GAP_PX
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
      const rowHeight = BODY_LINE_HEIGHT_PX + 2 * T.tableCellPaddingYPx
      const tableWidth = columnWidths.reduce((total, w) => total + w, 0)
      const rows: TableRowSceneNode[] = node.children.map((row, rowIndex) => {
        const rowY = cursor.y
        // The first mdast table row IS the header; GitHub bolds it and
        // starts its zebra on the row after, so the parity check counts
        // from the header exactly as `tr:nth-child(2n)` does.
        const header = rowIndex === 0
        const striped = rowIndex % 2 === 1
        let x = cursor.x
        const cells: TableCellSceneNode[] = row.children.map((cell, cellIndex) => {
          const width = columnWidths[cellIndex] ?? 0
          const cellX = x
          x += width
          const { runs } = layoutPhrasing(
            cell.children,
            { y: rowY + T.tableCellPaddingYPx, x: T.tableCellPaddingXPx },
            { ...options, maxWidth: width - 2 * T.tableCellPaddingXPx },
            BODY_FONT_SIZE_PX,
            header ? { strong: true } : {},
          )
          return {
            kind: 'tableCell',
            bbox: { x: cellX, y: rowY, w: width, h: rowHeight },
            runs,
            appearance: borderPaint(),
          }
        })
        cursor.y += rowHeight
        return {
          kind: 'tableRow',
          bbox: { x: cursor.x, y: rowY, w: tableWidth, h: rowHeight },
          cells,
          ...(header ? { header: true } : {}),
          ...(striped ? { appearance: panelPaint(T.tableStripeOpacity) } : {}),
        }
      })
      cursor.y += BLOCK_GAP_PX
      const table: TableBlockNode = {
        kind: 'table',
        bbox: { x: cursor.x, y: startY, w: tableWidth, h: cursor.y - startY - BLOCK_GAP_PX },
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
      const height = node.value.split('\n').length * CODE_LINE_HEIGHT_PX
      const fragment: SvgFragmentNode = {
        kind: 'svgFragment',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: height },
        svg: rendered,
      }
      cursor.y += height + BLOCK_GAP_PX
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
  options: MdastLayoutOptions,
): SvgFragmentNode {
  const fragment = typeof rendered === 'string' ? { svg: rendered } : rendered
  const width =
    fragment.width !== undefined && Number.isFinite(fragment.width) && fragment.width > 0
      ? Math.min(fragment.width, options.maxWidth)
      : options.maxWidth
  const height =
    fragment.height !== undefined && Number.isFinite(fragment.height) && fragment.height > 0
      ? fragment.height
      : CODE_LINE_HEIGHT_PX
  const node: SvgFragmentNode = {
    kind: 'svgFragment',
    bbox: { x: 0, y: cursor.y, w: width, h: height },
    svg: fragment.svg,
  }
  cursor.y += height + BLOCK_GAP_PX
  return node
}

function layoutListItem(
  item: MdastListItem,
  ordinal: number | undefined,
  cursor: Cursor,
  options: MdastLayoutOptions,
  depth: number,
  embedPath: readonly string[],
): ListItemNode {
  const startY = cursor.y
  const indented: MdastLayoutOptions = { ...options, maxWidth: options.maxWidth - LIST_INDENT_PX }
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
    const metrics = options.measure(markerText, bodyFont(options.fontFamily, BODY_FONT_SIZE_PX))
    const markerWidth = clampAdvance(metrics.advanceWidth)
    children.unshift({
      kind: 'textRun',
      bbox: {
        // Right-aligned against the content edge, not parked at the far side
        // of the gutter — see `listMarkerGapPx`.
        x: -(markerWidth + T.listMarkerGapPx),
        y: startY,
        w: markerWidth,
        h: BODY_LINE_HEIGHT_PX,
      },
      baseline: clampAdvance(baselineIn(BODY_LINE_HEIGHT_PX, BODY_FONT_SIZE_PX, metrics.ascent)),
      text: markerText,
      appearance: { fontFamily: options.fontFamily, fontSize: BODY_FONT_SIZE_PX },
    })
  }
  // Prose blocks each close with a full block gap; inside a list that reads
  // as items drifting apart, so the item's own trailing gap is tightened.
  cursor.y -= BLOCK_GAP_PX - T.listItemGapPx
  return {
    kind: 'listItem',
    bbox: {
      x: LIST_INDENT_PX * depth,
      y: startY,
      w: options.maxWidth - LIST_INDENT_PX * depth,
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
  options: MdastLayoutOptions,
  embedPath: readonly string[],
): EmbedResolvedNode | EmbedPlaceholderNode {
  const startY = cursor.y
  const resolved = tryResolveEmbed(options, documentId)
  const placeholder = (reason: EmbedPlaceholderNode['reason']): EmbedPlaceholderNode => {
    const node: EmbedPlaceholderNode = {
      kind: 'embedPlaceholder',
      bbox: { x: 0, y: startY, w: options.maxWidth, h: BODY_FONT_SIZE_PX },
      documentId,
      title: resolved?.title ?? documentId,
      reason,
    }
    cursor.y += BODY_FONT_SIZE_PX + BLOCK_GAP_PX
    return node
  }
  if (embedPath.includes(documentId)) return placeholder('cycle')
  if (embedPath.length >= EMBED_DEPTH_CAP) return placeholder('depthCap')
  if (resolved === undefined) return placeholder('unresolvable')
  const nextPath = [...embedPath, documentId]
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
 * The single mdast -> scene-graph render path. The exact same function
 * feeds preview, a spatial text node host, and export — there is no
 * separate HTML renderer.
 */
export function layoutMdastBlocks(root: MdastRoot, options: MdastLayoutOptions): Scene {
  const cursor: Cursor = { y: 0, x: 0 }
  const nodes = root.children.map((child) => layoutBlock(child, cursor, options, 0))
  return { nodes }
}
