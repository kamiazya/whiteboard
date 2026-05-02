import type { Migration } from 'kysely'
import { migration as init } from './0001-init.js'
import { migration as canvasesLastCompactedAt } from './0002-canvases-last-compacted-at.js'

// Ordered map; kysely sorts by key so the numeric prefix decides execution order.
export const migrations: Record<string, Migration> = {
  '0001-init': init,
  '0002-canvases-last-compacted-at': canvasesLastCompactedAt,
}
