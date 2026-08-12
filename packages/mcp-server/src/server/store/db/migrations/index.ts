import type { Migration } from 'kysely'
import { migration as init } from './0001-init.js'
import { migration as canvasesLastCompactedAt } from './0002-canvases-last-compacted-at.js'
import { migration as canvasDocStore } from './0003-canvas-doc-store.js'
import { migration as workspaceIndex } from './0004-workspace-index.js'
import { migration as canvasesKind } from './0005-canvases-kind.js'
import { migration as dropWorkspaceIndex } from './0006-drop-workspace-index.js'

// Ordered map; kysely sorts by key so the numeric prefix decides execution order.
// 0002-canvases-last-compacted-at is a no-op kept only so databases created by the
// published v0.0.6 release (which recorded it as applied) are not flagged as corrupted.
export const migrations: Record<string, Migration> = {
  '0001-init': init,
  '0002-canvases-last-compacted-at': canvasesLastCompactedAt,
  '0003-canvas-doc-store': canvasDocStore,
  '0004-workspace-index': workspaceIndex,
  '0005-canvases-kind': canvasesKind,
  '0006-drop-workspace-index': dropWorkspaceIndex,
}
