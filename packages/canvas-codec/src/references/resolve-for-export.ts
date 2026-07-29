import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-canvas-model/mdast'

export type CanvasPathResolver = (canvasId: string) => string | null

function wikiLinkExportText(alias: string | undefined, path: string): string {
  const label = alias ?? path
  return `[${label}](${path})`
}

function exportPhrasing(
  node: MdastPhrasingContent,
  resolver: CanvasPathResolver,
): MdastPhrasingContent {
  if (node.type === 'wikiLink' || node.type === 'embed') {
    const path = resolver(node.canvasId)
    if (path === null) {
      const alias = node.type === 'wikiLink' ? node.alias : undefined
      return { type: 'text', value: `[[canvas:${node.canvasId}${alias ? `|${alias}` : ''}]]` }
    }
    return {
      type: 'text',
      value: node.type === 'embed' ? `![${path}](${path})` : wikiLinkExportText(node.alias, path),
    }
  }
  if ('children' in node) {
    return { ...node, children: node.children.map((child) => exportPhrasing(child, resolver)) }
  }
  return node
}

function exportCellPhrasing(
  node: MdastCellPhrasingContent,
  resolver: CanvasPathResolver,
): MdastCellPhrasingContent {
  return exportPhrasing(node as MdastPhrasingContent, resolver) as MdastCellPhrasingContent
}

function exportFlow(node: MdastFlowContent, resolver: CanvasPathResolver): MdastFlowContent {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return { ...node, children: node.children.map((child) => exportPhrasing(child, resolver)) }
    case 'blockquote':
      return { ...node, children: node.children.map((child) => exportFlow(child, resolver)) }
    case 'list':
      return { ...node, children: node.children.map((child) => exportListItem(child, resolver)) }
    case 'table':
      return { ...node, children: node.children.map((child) => exportTableRow(child, resolver)) }
    default:
      return node
  }
}

function exportListItem(node: MdastListItem, resolver: CanvasPathResolver): MdastListItem {
  return { ...node, children: node.children.map((child) => exportFlow(child, resolver)) }
}

function exportTableRow(node: MdastTableRow, resolver: CanvasPathResolver): MdastTableRow {
  return { ...node, children: node.children.map((child) => exportTableCell(child, resolver)) }
}

function exportTableCell(node: MdastTableCell, resolver: CanvasPathResolver): MdastTableCell {
  return { ...node, children: node.children.map((child) => exportCellPhrasing(child, resolver)) }
}

/**
 * Rewrites `wikiLink`/`embed` nodes into plain relative-path markdown links
 * for export to a non-OpenCanvas-aware reader. Pure, single-document: the
 * canvasId->path resolver is injected. An unresolved id stays as literal
 * `[[canvas:ID]]` text rather than being dropped, so re-applying export with
 * the same resolver is idempotent (nothing left to resolve differently the
 * second time).
 */
export function resolveReferencesForExport(
  root: MdastRoot,
  resolver: CanvasPathResolver,
): MdastRoot {
  return { ...root, children: root.children.map((child) => exportFlow(child, resolver)) }
}
