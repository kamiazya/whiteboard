import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import { expandEmojiShortcodes } from '@kamiazya/whiteboard-plugin-visual/emoji/shortcode'
import { iconShortcodeRanges } from '@kamiazya/whiteboard-plugin-visual/icons/shortcode'
import type {
  BlockquoteNode,
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
  TableRowSceneNode,
  TextRunNode,
  ThematicBreakNode,
  UnresolvedReferenceNode,
} from '@kamiazya/whiteboard-scene'
import { selectCanvasFragment } from '../../canvas-fragment.js'
import { clampAdvance } from '../../measure.js'
import type { EmbeddedDocument } from '../../references/resolved.js'
import { referenceFor, withReferenceSeams } from '../../references/seams.js'
import { MARKDOWN_THEME_NODE } from '../../theme/markdown-theme.js'
import { jaModel } from '../../vendor/budoux/ja-model.js'
import { Parser } from '../../vendor/budoux/parser.js'
import { escapeXmlText } from '../../xml-escape.js'
import { createInlineJunction, headCharacter } from './inline-junction.js'
import { layoutCodeBlock } from './mdast-code-block.js'
import {
  baselineIn,
  bodyFont,
  bodyLineHeightPx,
  type Cursor,
  codeFontSizePx,
  codeLineHeightPx,
  type EmbeddedCanvasBox,
  type EmbeddedCanvasMiniature,
  type MdastLayoutOptions,
  measureRunWidth,
  type PhrasingLayout,
  panelPaint,
  placeFragment,
  type RenderedSvgFragment,
  type ResolvedMdastOptions,
} from './mdast-layout-options.js'
import { selectMarkdownSection } from './mdast-section.js'
import { layoutTableRow, tableColumnWidths } from './mdast-table.js'
import { checkboxMarker } from './task-checkbox.js'
import { fitToWidth } from './truncate.js'
import { uaxSegments } from './uax-segments.js'

/**
 * What an alt-less inline image reads as. A box has to exist for the
 * picture to go in, and an empty string measures to zero width — so this is
 * a width, not a label. One en-space rather than a word: it is not text
 * anybody wrote, and a reader who has the image does not need telling.
 */
const IMAGE_PLACEHOLDER = '\u2002'
/**
 * An EM space, which a font defines as one em — so the run's box is a body-
 * sized square WIDE, and as tall as the line. A `<symbol>` letterboxes
 * rather than stretches, so the icon draws at the smaller side (the width)
 * and is centred in the line box: body-sized, on the prose's optical
 * centre. The EN space the image placeholder uses would halve it.
 *
 * Measured in a real browser rather than reasoned: the layout's own fake
 * measurer charges 0.6em per character whatever the character is, so it
 * reports a narrower box than any real face gives this one.
 */
const ICON_PLACEHOLDER = '\u2003'

/**
 * Every layout constant comes from ONE theme object (theme/markdown-theme.ts),
 * calibrated to GitHub's rendered-markdown surface. Read once here so the
 * rest of the file reads as geometry rather than as a table of numbers, and
 * so restyling stays a data change.
 */
// The metrics a NODE is laid out with. Exported because `apps/web`'s edit
// overlay has to sit on the same line box the render draws, and a node is what
// it edits — see MdastLayoutOptions.theme for the surface that differs.
/** Root depth is 0; a 4th level degrades to a placeholder (package rule, decision 4). */
const EMBED_DEPTH_CAP = 3

/**
 * How a reference reads when it carries a `#fragment`: the document's name,
 * then the part inside it — `Roadmap › Launch` — the way a breadcrumb reads
 * and Obsidian labels `[[note#heading]]`. An explicit `|label` always wins
 * over this, at the call sites.
 */
function referenceLabel(title: string, fragment: string | undefined): string {
  return fragment === undefined ? title : `${title} › ${fragment}`
}

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

function isFinitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
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
/**
 * Replace `segments[index]` with a finer breakdown of it — phrase -> UAX #14
 * segments -> code points — answering false when there is no finer level,
 * which makes the segment irreducible.
 */
function splitFiner(segments: string[], index: number, segment: string): boolean {
  const finer = finerSegments(segment)
  if (finer.length <= 1) return false
  segments.splice(index, 1, ...finer)
  return true
}

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
  const junction = createInlineJunction(runs, line, lineHeightPx)

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
    // as `typesetMdastBlocks` running into the word after it.
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
    junction.placed(text, extra.paints)
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
    /**
     * True once the preceding stretch has been MOVED down to the next line
     * with this segment. That only happens when nothing of this node has
     * landed yet and the segment may not open a line: the stretch it is
     * joined to comes down with it, rather than the pair being split across
     * the break. `relocateCluster` performs the move, so the order of the
     * conjuncts is what stops it running when the situation does not call
     * for it.
     */
    const clusterCameDown = (segment: string): boolean =>
      buffered === '' &&
      line.x > 0 &&
      !junction.breakableBefore(headCharacter(segment, extra.paints)) &&
      junction.relocateCluster()
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
    /**
     * Place one segment, answering whether the SAME index must be visited
     * again — either because the line under it moved, or because the
     * segment itself was replaced by finer pieces.
     */
    const placeSegment = (index: number): 'placed' | 'retry' => {
      const segment = segments[index] ?? ''
      const candidate = buffered + segment
      if (line.x + widthOf(candidate.trimEnd()) <= options.maxWidth) {
        buffered = candidate
        return 'placed'
      }
      // Retried on the new line, where it either fits or falls through to
      // the ordinary break below.
      if (clusterCameDown(segment)) return 'retry'
      if (buffered !== '' || line.x > 0) {
        flush()
        junction.startLine()
        // A boundary space at the start of a line is dropped, not advanced.
        segments[index] = segment.trimStart()
        return 'retry'
      }
      // Alone at the start of a line and still too wide: step down one level
      // of granularity. What cannot be stepped down is irreducible and is
      // left to overflow rather than dropped.
      if (splitFiner(segments, index, segment)) return 'retry'
      buffered = candidate
      return 'placed'
    }

    for (let index = 0; index < segments.length; index++) {
      if (placeSegment(index) === 'retry') index -= 1
    }
    flush()
  }

  /**
   * An atomic run is never SPLIT — an interior space in a code span or an
   * HTML tag is not a word boundary — so cutting it is the only way left to
   * keep it inside the box, and the run says so.
   *
   * Inline MATH is atomic AND uncuttable, which is why `truncatable` is a
   * separate answer: `a + b + c` cut to `a + b` reads as a complete formula
   * that is simply wrong, where cut code or cut markup reads as cut.
   * Overflowing is the lesser harm.
   */
  const emitAtomic = (
    text: string,
    extra: Partial<TextRunNode>,
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
    cuttable: boolean,
    font?: { family: string; sizePx: number },
  ) => {
    const atomicFont = font ?? { family: options.fontFamily, sizePx: fontSizePx }
    // A backdrop's padding is part of what the run occupies, so it comes
    // out of the fit budget too — otherwise the pill is cut to the wrap
    // width and its padding paints past it.
    const padX = isFinitePositive(extra.backdropPadXPx) ? extra.backdropPadXPx : 0
    const fitted = cuttable
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
  }

  /**
   * Place one already-collapsed stretch, whole if it fits on the current
   * line and through the wrapper if it does not.
   */
  const placeCollapsed = (
    collapsed: string,
    extra: Partial<TextRunNode>,
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
    canWrap: boolean,
  ) => {
    const fullWidth = measureRunWidth(
      options.measure,
      options.fontFamily,
      collapsed,
      fontSizePx,
      runStyle,
    )
    if (canWrap && line.x + fullWidth > options.maxWidth) wrapAndPush(collapsed, extra, runStyle)
    else pushRun(collapsed, extra, runStyle)
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
    // Decided ONCE per inline node, before anything of it is placed: a break
    // UAX #14 allows on this node's left edge opens a new cluster, one it
    // forbids joins the node to the stretch already on the line.
    const joinedToPrevious = !junction.breakableBefore(headCharacter(text, extra.paints))
    if (!wrappable) {
      if (!joinedToPrevious) junction.allowBreakHere()
      emitAtomic(text, extra, runStyle, canWrap && truncatable, font)
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
    if (!joinedToPrevious) junction.allowBreakHere()
    if (collapsed !== '') placeCollapsed(collapsed, extra, runStyle, canWrap)
    if (/\s$/.test(text)) {
      line.x += spaceWidth
      junction.allowBreakHere()
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

  /**
   * One text node's string, with both shortcode vocabularies applied.
   *
   * They cannot be applied the same way. An emoji is a CHARACTER, so it is
   * substituted into the string and the run never knows; an icon is drawn
   * geometry, so it needs a run of its own carrying `paints` for the
   * painter. Icons are therefore split out FIRST, off offsets taken from
   * the raw string, and the emoji expansion runs within each surviving
   * segment — expanding first would move every offset after the first
   * emoji.
   *
   * The icon run is ATOMIC (`wrappable: false`) for the reason the alt-less
   * image placeholder is: the wrappable path collapses `text.trim()`, which
   * erases a whitespace placeholder and the run with it.
   */
  const emitWithIcons = (
    value: string,
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    let at = 0
    for (const range of iconShortcodeRanges(value)) {
      if (range.from > at)
        emit(expandEmojiShortcodes(value.slice(at, range.from)), {}, currentStyle)
      emit(ICON_PLACEHOLDER, { paints: { kind: 'icon', name: range.name } }, currentStyle, false)
      at = range.to
    }
    if (at === 0) {
      emit(expandEmojiShortcodes(value), {}, currentStyle)
      return
    }
    if (at < value.length) emit(expandEmojiShortcodes(value.slice(at)), {}, currentStyle)
  }

  /**
   * An image stays a RUN, with `text` as the alt — see `paints` on
   * TextRunNode.
   *
   * An alt-LESS one takes a placeholder ATOMICALLY: the wrappable path
   * collapses `text.trim()`, which erases a whitespace placeholder and the
   * run with it (measured). One WITH an alt stays wrappable, because an alt
   * is prose.
   *
   * Where the picture actually loads from is the CALLER's, the same way a
   * file node's is — a written path may be a workspace attachment. An
   * unresolved one keeps what the markdown said, so an absolute URL still
   * works.
   */
  const emitImage = (
    child: { alt?: string | null; url: string },
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    const alt =
      child.alt === undefined || child.alt === null || child.alt === '' ? undefined : child.alt
    const src =
      referenceFor(child.url, options.references?.resolveReference)?.image?.href ?? child.url
    emit(
      alt ?? IMAGE_PLACEHOLDER,
      { paints: { kind: 'image', src } },
      currentStyle,
      alt !== undefined,
    )
  }

  /** A wiki link's label is the alias when written, else the resolved title. */
  const emitWikiLink = (
    child: { documentId: string; alias?: string | undefined; fragment?: string | undefined },
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    const label =
      child.alias ??
      referenceLabel(tryResolveTitle(options, child.documentId) ?? child.documentId, child.fragment)
    emit(
      label,
      {
        link: {
          kind: 'wikiLink',
          documentId: child.documentId,
          ...(child.alias ? { alias: child.alias } : {}),
          ...(child.fragment ? { fragment: child.fragment } : {}),
        },
      },
      currentStyle,
    )
  }

  /**
   * Inline — mixed into prose — an embed stays a link run; the resolved
   * title is a better label than the raw id when known.
   */
  const emitEmbed = (
    child: { documentId: string; fragment?: string | undefined },
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    emit(
      referenceLabel(
        tryResolveEmbed(options, child.documentId)?.title ?? child.documentId,
        child.fragment,
      ),
      {
        link: {
          kind: 'embed',
          documentId: child.documentId,
          ...(child.fragment ? { fragment: child.fragment } : {}),
        },
      },
      currentStyle,
    )
  }

  const walk = (
    nodes: readonly (MdastPhrasingContent | MdastCellPhrasingContent)[],
    currentStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    for (const child of nodes) {
      switch (child.type) {
        case 'text':
          // Every body-drawing surface comes through here; `inlineCode`
          // below deliberately does not, a shortcode there being the subject.
          emitWithIcons(child.value, currentStyle)
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
          junction.startLine()
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
          if (child.children.length === 0) emit(child.identifier, { link }, currentStyle)
          else walkLinked(child.children, currentStyle, link)
          break
        }
        case 'image':
          emitImage(child, currentStyle)
          break
        case 'imageReference':
          emit(child.alt ?? child.identifier, {}, currentStyle)
          break
        case 'inlineMath':
          emit(child.value, {}, currentStyle, false, false)
          break
        case 'wikiLink':
          emitWikiLink(child, currentStyle)
          break
        case 'embed':
          emitEmbed(child, currentStyle)
          break
      }
    }
  }

  walk(children, style)
  const inkWidth = runs.reduce((widest, run) => Math.max(widest, run.bbox.x + run.bbox.w), 0)
  return { runs, lineCount: line.index + 1, inkWidth }
}

/**
 * Display math. A THROWING renderer degrades this one node to the
 * placeholder (the total-layout rule), exactly as `renderDiagram` does.
 */
function layoutMathBlock(
  node: Extract<MdastFlowContent, { type: 'math' }>,
  cursor: Cursor,
  options: ResolvedMdastOptions,
): SceneNode {
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

function layoutBlock(
  node: MdastFlowContent,
  cursor: Cursor,
  options: ResolvedMdastOptions,
  depth: number,
  // document ids of the embeds currently being laid out on THIS recursion
  // path — the cycle/cap contract (decision 4), threaded rather than
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
        return layoutEmbedBlock(only.documentId, only.fragment, cursor, options, embedPath)
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
    case 'code':
      return layoutCodeBlock(node, cursor, options)
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
      const rows: TableRowSceneNode[] = node.children.map((row, rowIndex) =>
        layoutTableRow(row, rowIndex, node.children.length, {
          cursor,
          options,
          columnWidths,
          tableWidth,
          layoutPhrasing,
        }),
      )
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
    case 'math':
      return layoutMathBlock(node, cursor, options)
  }
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
  // The gutter: a bullet, an ordinal, or a task item's checkbox INSTEAD of
  // one (`task-checkbox.ts` says why it is rects). Wrapper-RELATIVE, so the
  // gutter left of the content is negative x.
  if (item.checked === true || item.checked === false) {
    children.unshift(...checkboxMarker(options.theme, item.checked, startY, bodyLineHeightPx))
  } else {
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
 * degrade to an `embedPlaceholder` with the matching reason, so no resolver
 * can loop or abort layout.
 */
function layoutEmbedBlock(
  documentId: string,
  fragment: string | undefined,
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
      title: referenceLabel(resolved?.title ?? documentId, fragment),
      reason,
    }
    cursor.y += options.theme.bodyFontSizePx + options.theme.blockGapPx
    return node
  }
  if (embedPath.includes(documentId)) return placeholder('cycle')
  if (embedPath.length >= EMBED_DEPTH_CAP) return placeholder('depthCap')
  if (resolved === undefined) return placeholder('unresolvable')
  const nextPath = [...embedPath, documentId]
  // A fragment narrows the document to the part it names. One the document
  // does not hold is unresolvable in the same way a missing document is:
  // the reader sees the address, linked, and nothing is invented.
  if ('canvas' in resolved) {
    if (options.layoutEmbeddedCanvas === undefined) return placeholder('unresolvable')
    const canvas =
      fragment === undefined ? resolved.canvas : selectCanvasFragment(resolved.canvas, fragment)
    if (canvas === undefined) return placeholder('unresolvable')
    return layoutCanvasEmbedBlock(documentId, fragment, canvas, cursor, options, nextPath)
  }
  const root =
    fragment === undefined ? resolved.root : selectMarkdownSection(resolved.root, fragment)
  if (root === undefined) return placeholder('unresolvable')
  const children = root.children.map((child) => layoutBlock(child, cursor, options, 0, nextPath))
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
  fragment: string | undefined,
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
    [{ type: 'embed', documentId, ...(fragment === undefined ? {} : { fragment }) }],
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
export function typesetMdastBlocks(root: MdastRoot, options: MdastLayoutOptions): Scene {
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
function resolveTheme(options: MdastLayoutOptions): ResolvedMdastOptions {
  return { ...withReferenceSeams(options), theme: options.theme ?? MARKDOWN_THEME_NODE }
}

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
    // `typesetMdastBlocks` never emits an edge (the one variant with no
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
