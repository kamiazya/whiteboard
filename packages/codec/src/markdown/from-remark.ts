import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-model/mdast'

/**
 * remark/mdast-util nodes carry `position`, and extension-specific nodes
 * (gfm/math) carry extra bookkeeping fields (`checked`, `data`, ...) this
 * package doesn't model. Rather than typing against `@types/mdast` (a
 * dependency this package otherwise has no need for), every remark node is
 * treated as an untyped record and narrowed by its `type` tag — the model
 * schemas (`mdastRootSchema` et al.) are the actual structural contract;
 * this converter only needs to strip the extra remark-only fields down to
 * that contract.
 */
type RemarkNode = { type: string; children?: RemarkNode[]; [key: string]: unknown }

/** A string field, absent read as empty — mdast's value-bearing fields are required. */
const textOf = (node: RemarkNode, key: string): string => String(node[key] ?? '')

/**
 * An optional field. remark represents an absent value as `null` (e.g.
 * `start` on an unordered list), not `undefined` — `mdastRootSchema`'s
 * `.optional()` fields reject `null`, so this must be coerced at the
 * boundary rather than cast straight through.
 */
const optionalOf = <T>(node: RemarkNode, key: string): T | undefined =>
  (node[key] as T | null | undefined) ?? undefined

/**
 * How deep a converted tree may nest before a container is flattened to its
 * text. Every reader of the model tree — the schema parse, layout, the writer
 * — recurses, and markdown nests one level per character (`>>>>…`, `- - - …`,
 * `***…`), so a body far inside the length limit could otherwise exhaust the
 * stack. No document a person reads nests anywhere near this deep.
 */
const MAX_NESTING_DEPTH = 64

const childrenOf = <T>(
  node: RemarkNode,
  depth: number,
  convert: (child: RemarkNode, depth: number) => T,
): T[] => (node.children ?? []).map((child) => convert(child, depth + 1))

/**
 * A subtree's text in document order, walked with an explicit stack: the
 * subtree being flattened is by definition too deep to recurse over.
 */
function flattenText(node: RemarkNode): string {
  let text = ''
  const stack: RemarkNode[] = [node]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (typeof next.value === 'string') text += next.value
    const children = next.children ?? []
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as RemarkNode)
  }
  return text
}

const tooDeep = (node: RemarkNode, depth: number): boolean =>
  depth >= MAX_NESTING_DEPTH && node.children !== undefined

const phrasingAt = (node: RemarkNode, depth: number): MdastPhrasingContent =>
  tooDeep(node, depth) ? { type: 'text', value: flattenText(node) } : toPhrasing(node, depth)

const flowAt = (node: RemarkNode, depth: number): MdastFlowContent =>
  tooDeep(node, depth)
    ? { type: 'paragraph', children: [{ type: 'text', value: flattenText(node) }] }
    : toFlow(node, depth)

const footnoteMarker = (node: RemarkNode): string =>
  `[^${optionalOf<string>(node, 'label') ?? textOf(node, 'identifier')}]`

/**
 * A footnote definition has no node of its own in the model, so it reads as
 * the paragraph it was written as: `[^label]: ` then its text. A definition
 * of one paragraph keeps that paragraph's inline formatting; one of several
 * blocks keeps their text, flattened, since a paragraph cannot hold blocks.
 */
function footnoteDefinitionAsParagraph(node: RemarkNode, depth: number): MdastFlowContent {
  const label: MdastPhrasingContent = { type: 'text', value: `${footnoteMarker(node)}: ` }
  const blocks = node.children ?? []
  const [only] = blocks
  if (blocks.length === 1 && only?.type === 'paragraph') {
    return { type: 'paragraph', children: [label, ...childrenOf(only, depth + 1, phrasingAt)] }
  }
  const text = blocks.map(flattenText).join(' ')
  return { type: 'paragraph', children: [label, { type: 'text', value: text }] }
}

function toPhrasing(node: RemarkNode, depth: number): MdastPhrasingContent {
  switch (node.type) {
    case 'text':
      return { type: 'text', value: textOf(node, 'value') }
    case 'inlineCode':
      return { type: 'inlineCode', value: textOf(node, 'value') }
    case 'break':
      return { type: 'break' }
    case 'html':
      return { type: 'html', value: textOf(node, 'value') }
    case 'inlineMath':
      return { type: 'inlineMath', value: textOf(node, 'value') }
    case 'emphasis':
      return { type: 'emphasis', children: childrenOf(node, depth, phrasingAt) }
    case 'strong':
      return { type: 'strong', children: childrenOf(node, depth, phrasingAt) }
    case 'delete':
      return { type: 'delete', children: childrenOf(node, depth, phrasingAt) }
    case 'link':
      return {
        type: 'link',
        url: textOf(node, 'url'),
        title: optionalOf<string>(node, 'title'),
        children: childrenOf(node, depth, phrasingAt),
      }
    case 'image':
      return {
        type: 'image',
        url: textOf(node, 'url'),
        title: optionalOf<string>(node, 'title'),
        alt: optionalOf<string>(node, 'alt'),
      }
    case 'linkReference':
      return {
        type: 'linkReference',
        identifier: textOf(node, 'identifier'),
        label: optionalOf<string>(node, 'label'),
        referenceType: node.referenceType as 'shortcut' | 'collapsed' | 'full',
        children: childrenOf(node, depth, phrasingAt),
      }
    case 'imageReference':
      return {
        type: 'imageReference',
        identifier: textOf(node, 'identifier'),
        label: optionalOf<string>(node, 'label'),
        referenceType: node.referenceType as 'shortcut' | 'collapsed' | 'full',
        alt: optionalOf<string>(node, 'alt'),
      }
    case 'footnoteReference':
      // The model has no footnote nodes; the marker stays as the author
      // wrote it rather than vanishing along with its leading space.
      return { type: 'text', value: footnoteMarker(node) }
    default:
      // Unrecognized node kinds degrade to their textual content rather than
      // being silently dropped (data loss the round-trip property would
      // otherwise mask).
      return { type: 'text', value: textOf(node, 'value') }
  }
}

function toCellPhrasing(node: RemarkNode, depth: number): MdastCellPhrasingContent {
  const phrasing = phrasingAt(node, depth)
  return phrasing as MdastCellPhrasingContent
}

function toFlow(node: RemarkNode, depth: number): MdastFlowContent {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', children: childrenOf(node, depth, phrasingAt) }
    case 'heading':
      return {
        type: 'heading',
        depth: node.depth as 1 | 2 | 3 | 4 | 5 | 6,
        children: childrenOf(node, depth, phrasingAt),
      }
    case 'blockquote':
      return { type: 'blockquote', children: childrenOf(node, depth, flowAt) }
    case 'list':
      return {
        type: 'list',
        ordered: optionalOf<boolean>(node, 'ordered'),
        start: optionalOf<number>(node, 'start'),
        spread: optionalOf<boolean>(node, 'spread'),
        children: childrenOf(node, depth, toListItem),
      }
    case 'code':
      return {
        type: 'code',
        value: textOf(node, 'value'),
        lang: optionalOf<string>(node, 'lang'),
        meta: optionalOf<string>(node, 'meta'),
      }
    case 'html':
      return { type: 'html', value: textOf(node, 'value') }
    case 'thematicBreak':
      return { type: 'thematicBreak' }
    case 'definition':
      return {
        type: 'definition',
        identifier: textOf(node, 'identifier'),
        label: optionalOf<string>(node, 'label'),
        url: textOf(node, 'url'),
        title: optionalOf<string>(node, 'title'),
      }
    case 'table':
      return {
        type: 'table',
        align: node.align as ('left' | 'right' | 'center' | null)[] | undefined,
        children: childrenOf(node, depth, toTableRow),
      }
    case 'math':
      return {
        type: 'math',
        value: textOf(node, 'value'),
        meta: optionalOf<string>(node, 'meta'),
      }
    case 'footnoteDefinition':
      return footnoteDefinitionAsParagraph(node, depth)
    default:
      return { type: 'paragraph', children: [{ type: 'text', value: textOf(node, 'value') }] }
  }
}

function toListItem(node: RemarkNode, depth: number): MdastListItem {
  return {
    type: 'listItem',
    checked: node.checked as boolean | null | undefined,
    spread: optionalOf<boolean>(node, 'spread'),
    children: childrenOf(node, depth, flowAt),
  }
}

function toTableRow(node: RemarkNode, depth: number): MdastTableRow {
  return { type: 'tableRow', children: childrenOf(node, depth, toTableCell) }
}

function toTableCell(node: RemarkNode, depth: number): MdastTableCell {
  return { type: 'tableCell', children: childrenOf(node, depth, toCellPhrasing) }
}

/** Converts a raw remark/mdast-util Root into the model MdastRoot subset. */
export function fromRemarkRoot(root: RemarkNode): MdastRoot {
  return { type: 'root', children: childrenOf(root, 0, flowAt) }
}
