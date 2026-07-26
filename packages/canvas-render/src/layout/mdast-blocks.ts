import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-canvas-model/internal'
import type { MeasureText } from '../measure.js'
import { clampAdvance } from '../measure.js'
import type {
  BlockquoteNode,
  CodeBlockNode,
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
const BODY_FONT_SIZE_PX = 16
const BLOCK_GAP_PX = 8
const LIST_INDENT_PX = 24
const TABLE_ROW_HEIGHT_PX = 24
const CODE_LINE_HEIGHT_PX = 20
const THEMATIC_BREAK_HEIGHT_PX = 1

function bodyFont(sizePx: number) {
  return { family: 'sans-serif', fallbackChain: [], weight: 400, style: 'normal' as const, sizePx }
}

export interface MdastLayoutOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  /**
   * Renders a math source string to an SVG fragment. Optional composition-
   * root seam — MathJax itself is never imported by this package. Absent a
   * real renderer, math nodes fall back to a deterministic placeholder
   * fragment carrying the raw source as escaped text.
   */
  readonly renderMath?: (value: string, displayMode: boolean) => string
}

/**
 * Fallback used only when the composition root has not supplied a real
 * math renderer. `value` is untrusted markdown-embedded math source, so it
 * must be escaped like any other text content — unlike a `renderMath`
 * result (or an `SvgFragmentNode.svg`), which is the composition root's own
 * precondition to supply as well-formed, already-trusted SVG.
 */
function defaultRenderMath(value: string): string {
  return `<text>${escapeXmlText(value)}</text>`
}

interface Cursor {
  y: number
}

function measureRunWidth(measure: MeasureText, text: string, sizePx: number): number {
  const metrics = measure(text, bodyFont(sizePx))
  return clampAdvance(metrics.advanceWidth)
}

/** Flattens phrasing content into an ordered list of styled text runs, at y with the given font size. */
function layoutPhrasing(
  children: readonly (MdastPhrasingContent | MdastCellPhrasingContent)[],
  cursor: Cursor,
  options: MdastLayoutOptions,
  fontSizePx: number,
  style: { emphasis?: boolean; strong?: boolean; deleted?: boolean } = {},
): TextRunNode[] {
  const runs: TextRunNode[] = []
  // Horizontal run placement (word-wrap-aware x/width accumulation) is
  // deferred; each run's bbox.x is left at 0 pending that follow-up. This
  // does not affect semantic provenance (heading level, list nesting, link
  // targets) or block-level (y-axis) geometry, which the golden test covers.
  const emit = (text: string, extra: Partial<TextRunNode> = {}) => {
    const width = measureRunWidth(options.measure, text, fontSizePx)
    runs.push({
      kind: 'textRun',
      bbox: { x: 0, y: cursor.y, w: width, h: fontSizePx },
      text,
      ...style,
      ...extra,
    })
  }

  for (const child of children) {
    switch (child.type) {
      case 'text':
        emit(child.value)
        break
      case 'inlineCode':
        emit(child.value, { code: true })
        break
      case 'break':
        break
      case 'html':
        emit(child.value)
        break
      case 'emphasis':
        runs.push(
          ...layoutPhrasing(child.children, cursor, options, fontSizePx, {
            ...style,
            emphasis: true,
          }),
        )
        break
      case 'strong':
        runs.push(
          ...layoutPhrasing(child.children, cursor, options, fontSizePx, {
            ...style,
            strong: true,
          }),
        )
        break
      case 'delete':
        runs.push(
          ...layoutPhrasing(child.children, cursor, options, fontSizePx, {
            ...style,
            deleted: true,
          }),
        )
        break
      case 'link': {
        const link: LinkProvenance = {
          kind: 'link',
          href: child.url,
          ...(child.title ? { title: child.title } : {}),
        }
        const nested = layoutPhrasing(child.children, cursor, options, fontSizePx, style)
        runs.push(...nested.map((r) => ({ ...r, link })))
        break
      }
      case 'linkReference': {
        const link: LinkProvenance = { kind: 'link', href: `#${child.identifier}` }
        if (child.children.length === 0) {
          emit(child.identifier, { link })
        } else {
          const nested = layoutPhrasing(child.children, cursor, options, fontSizePx, style)
          runs.push(...nested.map((r) => ({ ...r, link })))
        }
        break
      }
      case 'image':
        emit(child.alt ?? '')
        break
      case 'imageReference':
        emit(child.alt ?? child.identifier)
        break
      case 'inlineMath':
        emit(child.value)
        break
      case 'wikiLink':
        emit(child.alias ?? child.canvasId, {
          link: {
            kind: 'wikiLink',
            canvasId: child.canvasId,
            ...(child.alias ? { alias: child.alias } : {}),
          },
        })
        break
      case 'embed':
        emit(child.canvasId, { link: { kind: 'embed', canvasId: child.canvasId } })
        break
    }
  }
  return runs
}

function layoutBlock(
  node: MdastFlowContent,
  cursor: Cursor,
  options: MdastLayoutOptions,
  depth: number,
): SceneNode {
  switch (node.type) {
    case 'heading': {
      const runs = layoutPhrasing(node.children, cursor, options, HEADING_FONT_SIZE_PX[node.depth])
      const height = HEADING_FONT_SIZE_PX[node.depth]
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
      const runs = layoutPhrasing(node.children, cursor, options, BODY_FONT_SIZE_PX)
      const paragraph: ParagraphBlockNode = {
        kind: 'paragraph',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: BODY_FONT_SIZE_PX },
        runs,
      }
      cursor.y += BODY_FONT_SIZE_PX + BLOCK_GAP_PX
      return paragraph
    }
    case 'blockquote': {
      const startY = cursor.y
      const children = node.children.map((child) => layoutBlock(child, cursor, options, depth))
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
          const runs = layoutPhrasing(cell.children, { y: rowY }, options, BODY_FONT_SIZE_PX)
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
      const height = node.value.split('\n').length * CODE_LINE_HEIGHT_PX
      const fragment: SvgFragmentNode = {
        kind: 'svgFragment',
        bbox: { x: 0, y: cursor.y, w: options.maxWidth, h: height },
        svg: renderMath(node.value, true),
      }
      cursor.y += height + BLOCK_GAP_PX
      return fragment
    }
  }
}

function layoutListItem(
  item: MdastListItem,
  ordinal: number | undefined,
  cursor: Cursor,
  options: MdastLayoutOptions,
  depth: number,
): ListItemNode {
  const startY = cursor.y
  const indented: MdastLayoutOptions = { ...options, maxWidth: options.maxWidth - LIST_INDENT_PX }
  const children = item.children.map((child) => layoutBlock(child, cursor, indented, depth))
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
 * The single mdast -> scene-graph render path. The exact same function
 * feeds preview, a spatial text node host, and export — there is no
 * separate HTML renderer.
 */
export function layoutMdastBlocks(root: MdastRoot, options: MdastLayoutOptions): Scene {
  const cursor: Cursor = { y: 0 }
  const nodes = root.children.map((child) => layoutBlock(child, cursor, options, 0))
  return { nodes }
}
