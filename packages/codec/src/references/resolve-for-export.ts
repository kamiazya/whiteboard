import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-model/mdast'

export type DocumentPathResolver = (documentId: string) => string | null

function wikiLinkExportText(alias: string | undefined, path: string): string {
  const label = alias ?? path
  return `[${label}](${path})`
}

function exportPhrasing(
  node: MdastPhrasingContent,
  resolver: DocumentPathResolver,
): MdastPhrasingContent {
  if (node.type === 'wikiLink' || node.type === 'embed') {
    const path = resolver(node.documentId)
    // The fragment stays on the address in every form: it is part of what
    // the reference points at, and a plain-markdown reader can follow
    // `path#heading` exactly as it follows the path.
    const fragment = node.fragment === undefined ? '' : `#${node.fragment}`
    if (path === null) {
      const alias = node.type === 'wikiLink' ? node.alias : undefined
      return {
        type: 'text',
        value: `[[${node.documentId}${fragment}${alias ? `|${alias}` : ''}]]`,
      }
    }
    const address = `${path}${fragment}`
    return {
      type: 'text',
      value:
        node.type === 'embed'
          ? `![${address}](${address})`
          : wikiLinkExportText(node.alias, address),
    }
  }
  if ('children' in node) {
    return { ...node, children: node.children.map((child) => exportPhrasing(child, resolver)) }
  }
  return node
}

function exportCellPhrasing(
  node: MdastCellPhrasingContent,
  resolver: DocumentPathResolver,
): MdastCellPhrasingContent {
  return exportPhrasing(node as MdastPhrasingContent, resolver) as MdastCellPhrasingContent
}

function exportFlow(node: MdastFlowContent, resolver: DocumentPathResolver): MdastFlowContent {
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

function exportListItem(node: MdastListItem, resolver: DocumentPathResolver): MdastListItem {
  return { ...node, children: node.children.map((child) => exportFlow(child, resolver)) }
}

function exportTableRow(node: MdastTableRow, resolver: DocumentPathResolver): MdastTableRow {
  return { ...node, children: node.children.map((child) => exportTableCell(child, resolver)) }
}

function exportTableCell(node: MdastTableCell, resolver: DocumentPathResolver): MdastTableCell {
  return { ...node, children: node.children.map((child) => exportCellPhrasing(child, resolver)) }
}

/**
 * Rewrites `wikiLink`/`embed` nodes into plain relative-path markdown links
 * for export to a reader that knows only plain markdown. Pure, single-document: the
 * documentId->path resolver is injected. An unresolved id stays as literal
 * `[[ID]]` text rather than being dropped, so re-applying export with
 * the same resolver is idempotent (nothing left to resolve differently the
 * second time).
 */
export function resolveReferencesForExport(
  root: MdastRoot,
  resolver: DocumentPathResolver,
): MdastRoot {
  return { ...root, children: root.children.map((child) => exportFlow(child, resolver)) }
}
