import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-model/mdast'
import { type ReferenceMatch, scanReferences } from '../references/scan.js'

/**
 * Inverse of from-remark.ts: expands the model subset back into plain
 * objects shaped the way mdast-util-to-markdown expects (same field names,
 * no extra remark-only bookkeeping needed for stringification).
 *
 * A reference (`wikiLink`/`embed`, or the same syntax already sitting in a
 * `text` value, which is all a parse ever produces) becomes a
 * `referenceLiteral` node. The stringifier's own text handler would escape
 * the brackets of `[[x]]` — the parser reads them as plain text, so the
 * escape is correct for text but is not the project's reference syntax —
 * and `unsafe` can only ADD escapes, never remove one, so the node carries
 * its own handler (`referenceLiteralExtension`) that writes the brackets
 * bare and still routes the address and alias through the stringifier's
 * `safe()`, so whatever they hold is re-read as written.
 *
 * `RemarkNode` is a deliberately narrow local type, not the transitive
 * `mdast`/`@types/mdast` package types: this package does not depend on
 * `@types/mdast` directly, and remark's own types are only reachable
 * through `unified`'s plugin-inferred generics, not as a stable importable
 * name. The shape below is exactly what mdast-util-to-markdown needs: a
 * `type` discriminant plus whatever remark-shaped fields (`value`, `url`,
 * `children`, …) each node kind carries.
 */
type RemarkNode = {
  type: string
  [key: string]: unknown
}

const REFERENCE_LITERAL = 'referenceLiteral'

/**
 * The slice of mdast-util-to-markdown's `State` the handler below uses:
 * `safe` escapes a string for the construct being written, and in a table
 * cell that includes the `|` an alias separator would otherwise end the cell
 * with.
 */
type SafeState = { safe(value: string, config: { before: string; after: string }): string }

type ReferenceLiteral = { embed: boolean; address: string; alias?: string }

function handleReferenceLiteral(
  { embed, address, alias }: ReferenceLiteral,
  _parent: unknown,
  state: SafeState,
): string {
  const safeAddress = state.safe(address, { before: '[', after: alias === undefined ? ']' : '|' })
  const open = embed ? '![[' : '[['
  if (alias === undefined) return `${open}${safeAddress}]]`
  const separator = state.safe('|', { before: safeAddress.slice(-1), after: alias.charAt(0) })
  const safeAlias = state.safe(alias, { before: '|', after: ']' })
  return `${open}${safeAddress}${separator}${safeAlias}]]`
}

/** `toMarkdownExtensions` entry teaching the stringifier the `referenceLiteral` node. */
export const referenceLiteralExtension: {
  handlers: Record<string, typeof handleReferenceLiteral>
} = {
  handlers: { [REFERENCE_LITERAL]: handleReferenceLiteral },
}

/** The address half of a reference: the id, plus `#fragment` when one is set. */
function referenceAddress(node: { documentId: string; fragment?: string }): string {
  return node.fragment === undefined ? node.documentId : `${node.documentId}#${node.fragment}`
}

function referenceLiteral(embed: boolean, address: string, alias: string | undefined): RemarkNode {
  return { type: REFERENCE_LITERAL, embed, address, alias }
}

/**
 * The written address of a scanned match, taken from its text rather than
 * rebuilt from `target`/`fragment`: the scanner reads an empty fragment
 * (`[[p#]]`) as none, and rebuilding would drop the `#` the text carried.
 */
function matchAddress(match: ReferenceMatch): string {
  const open = match.isEmbed ? 3 : 2
  const close = match.alias === undefined ? 2 : match.alias.length + 3
  return match.full.slice(open, match.full.length - close)
}

function textWithReferences(value: string): RemarkNode[] {
  const pieces: RemarkNode[] = []
  let cursor = 0
  for (const match of scanReferences(value)) {
    if (match.index > cursor) pieces.push({ type: 'text', value: value.slice(cursor, match.index) })
    pieces.push(referenceLiteral(match.isEmbed, matchAddress(match), match.alias))
    cursor = match.index + match.full.length
  }
  if (pieces.length === 0) return [{ type: 'text', value }]
  if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) })
  return pieces
}

function toRemarkPhrasing(node: MdastPhrasingContent): RemarkNode[] {
  switch (node.type) {
    case 'text':
      return textWithReferences(node.value)
    case 'wikiLink':
      return [referenceLiteral(false, referenceAddress(node), node.alias)]
    case 'embed':
      return [referenceLiteral(true, referenceAddress(node), undefined)]
    case 'emphasis':
    case 'strong':
    case 'delete':
      return [{ type: node.type, children: node.children.flatMap(toRemarkPhrasing) }]
    case 'link':
    case 'linkReference':
      return [{ ...node, children: node.children.flatMap(toRemarkPhrasing) }]
    default:
      return [node]
  }
}

function toRemarkCellPhrasing(node: MdastCellPhrasingContent): RemarkNode[] {
  return toRemarkPhrasing(node as MdastPhrasingContent)
}

function toRemarkFlow(node: MdastFlowContent): RemarkNode {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return { ...node, children: node.children.flatMap(toRemarkPhrasing) }
    case 'blockquote':
      return { ...node, children: node.children.map(toRemarkFlow) }
    case 'list':
      return { ...node, children: node.children.map(toRemarkListItem) }
    case 'table':
      return { ...node, children: node.children.map(toRemarkTableRow) }
    default:
      return node
  }
}

function toRemarkListItem(node: MdastListItem): RemarkNode {
  return { ...node, children: node.children.map(toRemarkFlow) }
}

function toRemarkTableRow(node: MdastTableRow): RemarkNode {
  return { ...node, children: node.children.map(toRemarkTableCell) }
}

function toRemarkTableCell(node: MdastTableCell): RemarkNode {
  return { ...node, children: node.children.flatMap(toRemarkCellPhrasing) }
}

export function toRemarkRoot(root: MdastRoot): RemarkNode {
  return { type: 'root', children: root.children.map(toRemarkFlow) }
}
