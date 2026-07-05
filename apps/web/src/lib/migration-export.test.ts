import { describe, expect, it } from 'vitest'
import { migrationBundleSchema } from '@kamiazya/whiteboard-mcp/migration-bundle'

import type { CanvasSnapshot } from './whiteboard-client.js'
import { buildMigrationBundle } from './migration-export.js'

function makeSnapshot(overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
  return {
    id: 'canvas-1',
    name: 'My Canvas',
    scene: { elements: [{ id: 'el-1', type: 'rectangle' }] },
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildMigrationBundle', () => {
  it('returns a bundle that satisfies migrationBundleSchema', () => {
    const bundle = buildMigrationBundle([makeSnapshot()])
    expect(() => migrationBundleSchema.parse(bundle)).not.toThrow()
  })

  it('sets the correct format/version/sourceProvider literals', () => {
    const bundle = buildMigrationBundle([makeSnapshot()])
    expect(bundle.format).toBe('whiteboard-migration')
    expect(bundle.version).toBe(1)
    expect(bundle.sourceProvider).toBe('browser-local')
  })

  it('carries over id, name, and scene.elements from the snapshot', () => {
    const snapshot = makeSnapshot({ id: 'abc', name: 'Roadmap' })
    const bundle = buildMigrationBundle([snapshot])
    expect(bundle.canvases).toEqual([
      { id: 'abc', name: 'Roadmap', scene: { elements: snapshot.scene.elements } },
    ])
  })

  it('produces an ISO createdAt from an injected clock', () => {
    const now = () => new Date('2026-01-01T12:00:00.000Z')
    const bundle = buildMigrationBundle([makeSnapshot()], now)
    expect(bundle.createdAt).toBe('2026-01-01T12:00:00.000Z')
  })

  it('produces an empty canvases array that still parses when given no snapshots', () => {
    const bundle = buildMigrationBundle([])
    expect(bundle.canvases).toEqual([])
    expect(() => migrationBundleSchema.parse(bundle)).not.toThrow()
  })

  it('does not mutate the input snapshots array or its entries', () => {
    const snapshots = [makeSnapshot()]
    const frozenElements = snapshots[0].scene.elements
    buildMigrationBundle(snapshots)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].scene.elements).toBe(frozenElements)
  })
})
