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
 * Inverse of from-remark.ts: expands the model subset back into plain
 * objects shaped the way mdast-util-to-markdown expects (same field names,
 * no extra remark-only bookkeeping needed for stringification). `wikiLink`/
 * `embed` are converted to their bracket literal text form here — this
 * package renders them as plain markdown text rather than teaching
 * mdast-util-to-markdown a new node kind, since resolution happens at the
 * `references.ts` layer, before stringification.
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

function wikiLinkText(node: { documentId: string; alias?: string }): string {
  return node.alias === undefined
    ? `[[canvas:${node.documentId}]]`
    : `[[canvas:${node.documentId}|${node.alias}]]`
}

function toRemarkPhrasing(node: MdastPhrasingContent): RemarkNode {
  switch (node.type) {
    case 'wikiLink':
      return { type: 'text', value: wikiLinkText(node) }
    case 'embed':
      return { type: 'text', value: `![[canvas:${node.documentId}]]` }
    case 'emphasis':
    case 'strong':
    case 'delete':
      return { type: node.type, children: node.children.map(toRemarkPhrasing) }
    case 'link':
    case 'linkReference':
      return { ...node, children: node.children.map(toRemarkPhrasing) }
    default:
      return node
  }
}

function toRemarkCellPhrasing(node: MdastCellPhrasingContent): RemarkNode {
  return toRemarkPhrasing(node as MdastPhrasingContent)
}

function toRemarkFlow(node: MdastFlowContent): RemarkNode {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return { ...node, children: node.children.map(toRemarkPhrasing) }
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
  return { ...node, children: node.children.map(toRemarkCellPhrasing) }
}

export function toRemarkRoot(root: MdastRoot): RemarkNode {
  return { type: 'root', children: root.children.map(toRemarkFlow) }
}
