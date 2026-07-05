/**
 * Builds a MigrationBundle from browser-local canvas snapshots so a user can
 * export their data and import it into a daemon-backed workspace (or another
 * browser-local instance). Pure function — no UI wiring here.
 *
 * CanvasSnapshot (the persisted JSON 'canvases' row) is metadata-only —
 * elements are canonical in the Loro doc, not the JSON row — so the caller
 * must supply each canvas's current elements alongside its snapshot.
 */
import type { MigrationBundle } from '@kamiazya/whiteboard-mcp/migration-bundle'

import type { CanvasSnapshot } from './whiteboard-client.js'

export interface MigrationCanvasInput {
  snapshot: CanvasSnapshot
  elements: unknown[]
}

export function buildMigrationBundle(
  canvases: readonly MigrationCanvasInput[],
  now: () => Date = () => new Date(),
): MigrationBundle {
  return {
    format: 'whiteboard-migration',
    version: 1,
    sourceProvider: 'browser-local',
    createdAt: now().toISOString(),
    canvases: canvases.map(({ snapshot, elements }) => ({
      id: snapshot.id,
      name: snapshot.name,
      scene: { elements },
    })),
  }
}
