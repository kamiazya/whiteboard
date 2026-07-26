import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-canvas-model/internal'

/**
 * Inverse of from-remark.ts: expands the model subset back into plain
 * objects shaped the way mdast-util-to-markdown expects (same field names,
 * no extra remark-only bookkeeping needed for stringification). `wikiLink`/
 * `embed` are converted to their bracket literal text form here — this
 * package renders them as plain markdown text rather than teaching
 * mdast-util-to-markdown a new node kind, since resolution happens at the
 * `references.ts` layer, before stringification.
 */

function wikiLinkText(node: { canvasId: string; alias?: string }): string {
  return node.alias === undefined
    ? `[[canvas:${node.canvasId}]]`
    : `[[canvas:${node.canvasId}|${node.alias}]]`
}

function toRemarkPhrasing(node: MdastPhrasingContent): any {
  switch (node.type) {
    case 'wikiLink':
      return { type: 'text', value: wikiLinkText(node) }
    case 'embed':
      return { type: 'text', value: `![[canvas:${node.canvasId}]]` }
    case 'emphasis':
    case 'strong':
    case 'delete':
      return { type: node.type, children: node.children.map(toRemarkPhrasing) }
    case 'link':
      return { ...node, children: node.children.map(toRemarkPhrasing) }
    case 'linkReference':
      return { ...node, children: node.children.map(toRemarkPhrasing) }
    default:
      return node
  }
}

function toRemarkCellPhrasing(node: MdastCellPhrasingContent): any {
  return toRemarkPhrasing(node as MdastPhrasingContent)
}

function toRemarkFlow(node: MdastFlowContent): any {
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

function toRemarkListItem(node: MdastListItem): any {
  return { ...node, children: node.children.map(toRemarkFlow) }
}

function toRemarkTableRow(node: MdastTableRow): any {
  return { ...node, children: node.children.map(toRemarkTableCell) }
}

function toRemarkTableCell(node: MdastTableCell): any {
  return { ...node, children: node.children.map(toRemarkCellPhrasing) }
}

export function toRemarkRoot(root: MdastRoot): any {
  return { type: 'root', children: root.children.map(toRemarkFlow) }
}
