import type { Migration } from 'kysely'
import { migration as init } from './0001-init.js'
import { migration as importV0Filesystem } from './0002-import-v0-filesystem.js'
import { migration as versionsElementCount } from './0003-versions-element-count.js'
import { migration as canvasStableId } from './0004-canvas-stable-id.js'

// Ordered map; kysely sorts by key so the numeric prefix decides execution order.
export const migrations: Record<string, Migration> = {
  '0001-init': init,
  '0002-import-v0-filesystem': importV0Filesystem,
  '0003-versions-element-count': versionsElementCount,
  '0004-canvas-stable-id': canvasStableId,
}
