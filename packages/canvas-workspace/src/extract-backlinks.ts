import type { BacklinkRow } from '@kamiazya/whiteboard-canvas-ports'
import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-canvas-model/internal'

export function extractBacklinks(fromCanvasId: string, root: MdastRoot): readonly BacklinkRow[] {
  const seen = new Set<string>()
  const rows: BacklinkRow[] = []

  function visitPhrasing(node: MdastPhrasingContent): void {
    if (node.type === 'wikiLink' || node.type === 'embed') {
      if (!seen.has(node.canvasId)) {
        seen.add(node.canvasId)
        rows.push({ fromCanvasId, toCanvasId: node.canvasId })
      }
      return
    }
    if ('children' in node) {
      for (const child of node.children) visitPhrasing(child)
    }
  }

  function visitFlow(node: MdastFlowContent): void {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        for (const child of node.children) visitPhrasing(child)
        break
      case 'blockquote':
        for (const child of node.children) visitFlow(child)
        break
      case 'list':
        for (const item of node.children) {
          for (const child of item.children) visitFlow(child)
        }
        break
      case 'table':
        for (const row of node.children) {
          for (const cell of row.children) {
            for (const child of cell.children) visitPhrasing(child as MdastPhrasingContent)
          }
        }
        break
    }
  }

  for (const child of root.children) visitFlow(child)
  return rows
}
