import type { AliasResolver } from '@kamiazya/whiteboard-canvas-codec'
import type { WorkspaceTree } from './workspace-tree.js'

export function createAliasResolver(tree: WorkspaceTree): AliasResolver {
  return (alias: string): string | null => {
    const node = tree.findByAlias(alias)
    return node?.canvasId ?? null
  }
}
