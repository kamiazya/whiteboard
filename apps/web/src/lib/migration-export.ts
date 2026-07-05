/**
 * Builds a MigrationBundle from browser-local canvas snapshots so a user can
 * export their data and import it into a daemon-backed workspace (or another
 * browser-local instance). Pure function — no UI wiring here.
 */
import type { MigrationBundle } from '@kamiazya/whiteboard-mcp/migration-bundle'

import type { CanvasSnapshot } from './whiteboard-client.js'

export function buildMigrationBundle(
  canvases: readonly CanvasSnapshot[],
  now: () => Date = () => new Date(),
): MigrationBundle {
  return {
    format: 'whiteboard-migration',
    version: 1,
    sourceProvider: 'browser-local',
    createdAt: now().toISOString(),
    canvases: canvases.map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.name,
      scene: { elements: snapshot.scene.elements },
    })),
  }
}
