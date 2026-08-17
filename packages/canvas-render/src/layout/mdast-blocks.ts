import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-model/mdast'
import type { MeasureText } from '../measure.js'
import { clampAdvance } from '../measure.js'
import type {
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
  SvgFragmentNode,
  TableBlockNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
  ThematicBreakNode,
  UnresolvedReferenceNode,
} from '../scene-graph.js'
import { escapeXmlText } from '../svg/format.js'

/**
 * Minimal layout constants. Deliberately NOT a theme/design-token system
 * (that is the deferred theme layer, slice 4) — just enough fixed geometry
 * to make block layout deterministic. Revisit if a future slice needs
 * per-canvas overrides.
 */
const HEADING_FONT_SIZE_PX: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, number>> = {
  1: 32,
  2: 28,
  3: 24,
  4: 20,
  5: 18,
  6: 16,
}
export const BODY_FONT_SIZE_PX = 16
const BLOCK_GAP_PX = 8
const LIST_INDENT_PX = 24
const TABLE_ROW_HEIGHT_PX = 24
const CODE_LINE_HEIGHT_PX = 20
const THEMATIC_BREAK_HEIGHT_PX = 1

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
 * Word-wrap: a chunk of text that would exceed `options.maxWidth` on its
 * current line splits into per-word runs at whitespace boundaries, packed
 * greedily onto successive lines. A chunk that already fits (the common
 * case) stays a single run, unchanged from before wrapping existed — this
 * keeps wrapping's blast radius limited to the cases that actually overflow.
 * A single word wider than `maxWidth` on its own line is a deliberate
 * exception: it is left as one overflowing run rather than broken mid-word.
 * Wrapping is skipped entirely when `maxWidth` is non-finite or <= 0 (no
 * meaningful width to wrap against). Inline code, raw HTML, and inline math
 * runs are atomic — their source text may contain whitespace that is not a
 * word boundary (a code span's argument list, an HTML tag's attributes),
 * so they are always emitted as one run even when they overflow.
 */
function layoutPhrasing(
  children: readonly (MdastPhrasingContent | MdastCellPhrasingContent)[],
  cursor: Cursor,
  options: MdastLayoutOptions,
  fontSizePx: number,
  style: { emphasis?: boolean; strong?: boolean; deleted?: boolean } = {},
): PhrasingLayout {
  const runs: TextRunNode[] = []
  const line = { x: 0, index: 0 }
  const canWrap = Number.isFinite(options.maxWidth) && options.maxWidth > 0

  const pushRun = (
    text: string,
    extra: Partial<TextRunNode>,
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    const metrics = options.measure(text, bodyFont(options.fontFamily, fontSizePx, runStyle))
    const width = clampAdvance(metrics.advanceWidth)
    const baseline = clampAdvance(metrics.ascent)
    runs.push({
      kind: 'textRun',
      bbox: { x: line.x, y: cursor.y + line.index * fontSizePx, w: width, h: fontSizePx },
      baseline,
      text,
      ...runStyle,
      ...extra,
      // Stamped last so nothing can emit a run declaring a family OR SIZE
      // other than the ones it was measured with (see
      // MdastLayoutOptions.fontFamily) — a run drawn at the host's inherited
      // size would render every measured wrap width wrong and flatten the
      // heading hierarchy.
      appearance: { ...extra.appearance, fontFamily: options.fontFamily, fontSize: fontSizePx },
    })
    line.x += width
  }

  const wrapAndPush = (
    text: string,
    extra: Partial<TextRunNode>,
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean },
  ) => {
    // Input arrives collapse-normalized from `emit` (no boundary
    // whitespace, single-space separated), so a separator is due before
    // every word except the first — `emit` has already advanced the cursor
    // for the chunk's own leading space when one existed in the source.
    const words = text.split(' ')
    const spaceWidth = measureRunWidth(
      options.measure,
      options.fontFamily,
      ' ',
      fontSizePx,
      runStyle,
    )
    words.forEach((word, index) => {
      const width = measureRunWidth(options.measure, options.fontFamily, word, fontSizePx, runStyle)
      if (line.x > 0) {
        const separator = index > 0 ? spaceWidth : 0
        if (line.x + separator + width > options.maxWidth) {
          line.x = 0
          line.index += 1
        } else {
          line.x += separator
        }
      }
      pushRun(word, extra, runStyle)
    })
  }

  const emit = (
    text: string,
    extra: Partial<TextRunNode> = {},
    runStyle: { emphasis?: boolean; strong?: boolean; deleted?: boolean } = style,
    // Atomic runs (inline code, raw HTML, inline math) must never be split
    // mid-token at a whitespace boundary — unlike prose, an internal space
    // in their source text is not a word boundary.
    wrappable = true,
  ) => {
    if (!wrappable) {
      pushRun(text, extra, runStyle)
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
    const spaceWidth = measureRunWidth(options.measure, options.fontFamily, ' ', fontSizePx)
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
      if (canWrap && line.x + fullWidth > options.maxWidth && /\s/.test(collapsed)) {
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
          emit(child.value, { code: true }, currentStyle, false)
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
          emit(child.value, {}, currentStyle, false)
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
  return { runs, lineCount: line.index + 1 }
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
      const fontSizePx = HEADING_FONT_SIZE_PX[node.depth]
      const { runs, lineCount } = layoutPhrasing(node.children, cursor, options, fontSizePx)
      const height = lineCount * fontSizePx
      const heading: HeadingBlockNode = {
        kind: 'heading',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: height },
        level: node.depth,
        runs,
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
      const { runs, lineCount } = layoutPhrasing(node.children, cursor, options, BODY_FONT_SIZE_PX)
      const height = lineCount * BODY_FONT_SIZE_PX
      const paragraph: ParagraphBlockNode = {
        kind: 'paragraph',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: height },
        runs,
      }
      cursor.y += height + BLOCK_GAP_PX
      return paragraph
    }
    case 'blockquote': {
      const startY = cursor.y
      const children = node.children.map((child) =>
        layoutBlock(child, cursor, options, depth, embedPath),
      )
      const quote: BlockquoteNode = {
        kind: 'blockquote',
        bbox: { x: 0, y: startY, w: options.maxWidth, h: cursor.y - startY },
        children,
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
      const list: ListBlockNode = {
        kind: 'list',
        bbox: { x: 0, y: startY, w: options.maxWidth, h: cursor.y - startY },
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
      const height = lines.length * CODE_LINE_HEIGHT_PX
      const code: CodeBlockNode = {
        kind: 'codeBlock',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: height },
        value: node.value,
        ...(node.lang ? { lang: node.lang } : {}),
      }
      cursor.y += height + BLOCK_GAP_PX
      return code
    }
    case 'html': {
      const rawHtml: RawHtmlNode = {
        kind: 'rawHtml',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: BODY_FONT_SIZE_PX },
        value: node.value,
      }
      cursor.y += BODY_FONT_SIZE_PX + BLOCK_GAP_PX
      return rawHtml
    }
    case 'thematicBreak': {
      const hr: ThematicBreakNode = {
        kind: 'thematicBreak',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: THEMATIC_BREAK_HEIGHT_PX },
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
      const colWidth = node.children[0]
        ? options.maxWidth / Math.max(node.children[0].children.length, 1)
        : options.maxWidth
      const rows: TableRowSceneNode[] = node.children.map((row) => {
        const rowY = cursor.y
        const cells: TableCellSceneNode[] = row.children.map((cell, cellIndex) => {
          const { runs } = layoutPhrasing(cell.children, { y: rowY }, options, BODY_FONT_SIZE_PX)
          return {
            kind: 'tableCell',
            bbox: { x: cellIndex * colWidth, y: rowY, w: colWidth, h: TABLE_ROW_HEIGHT_PX },
            runs,
          }
        })
        cursor.y += TABLE_ROW_HEIGHT_PX
        return {
          kind: 'tableRow',
          bbox: { x: 0, y: rowY, w: options.maxWidth, h: TABLE_ROW_HEIGHT_PX },
          cells,
        }
      })
      cursor.y += BLOCK_GAP_PX
      const table: TableBlockNode = {
        kind: 'table',
        bbox: { x: 0, y: startY, w: options.maxWidth, h: cursor.y - startY - BLOCK_GAP_PX },
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
    children.unshift({
      kind: 'textRun',
      bbox: {
        x: -LIST_INDENT_PX,
        y: startY,
        w: clampAdvance(metrics.advanceWidth),
        h: BODY_FONT_SIZE_PX,
      },
      baseline: clampAdvance(metrics.ascent),
      text: markerText,
      appearance: { fontFamily: options.fontFamily, fontSize: BODY_FONT_SIZE_PX },
    })
  }
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
  const cursor: Cursor = { y: 0 }
  const nodes = root.children.map((child) => layoutBlock(child, cursor, options, 0))
  return { nodes }
}
