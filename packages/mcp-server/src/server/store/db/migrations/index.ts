import type { Migration } from 'kysely'
import { migration as init } from './0001-init.js'
import { migration as canvasesLastCompactedAt } from './0002-canvases-last-compacted-at.js'
import { migration as canvasDocStore } from './0003-canvas-doc-store.js'

// Ordered map; kysely sorts by key so the numeric prefix decides execution order.
// 0002-canvases-last-compacted-at is a no-op kept only so databases created by the
// published v0.0.6 release (which recorded it as applied) are not flagged as corrupted.
export const migrations: Record<string, Migration> = {
  '0001-init': init,
  '0002-canvases-last-compacted-at': canvasesLastCompactedAt,
  '0003-canvas-doc-store': canvasDocStore,
}
