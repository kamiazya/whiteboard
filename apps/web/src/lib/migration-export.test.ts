import { describe, expect, it } from 'vitest'
import { migrationBundleSchema } from '@kamiazya/whiteboard-mcp/migration-bundle'

import type { CanvasSnapshot } from './whiteboard-client.js'
import { buildMigrationBundle, type MigrationCanvasInput } from './migration-export.js'

function makeSnapshot(overrides: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
  return {
    id: 'canvas-1',
    name: 'My Canvas',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeInput(overrides: Partial<MigrationCanvasInput> = {}): MigrationCanvasInput {
  return {
    snapshot: makeSnapshot(),
    elements: [{ id: 'el-1', type: 'rectangle' }],
    ...overrides,
  }
}

describe('buildMigrationBundle', () => {
  it('returns a bundle that satisfies migrationBundleSchema', () => {
    const bundle = buildMigrationBundle([makeInput()])
    expect(() => migrationBundleSchema.parse(bundle)).not.toThrow()
  })

  it('sets the correct format/version/sourceProvider literals', () => {
    const bundle = buildMigrationBundle([makeInput()])
    expect(bundle.format).toBe('whiteboard-migration')
    expect(bundle.version).toBe(1)
    expect(bundle.sourceProvider).toBe('browser-local')
  })

  it('carries over id, name, and elements from the input', () => {
    const input = makeInput({ snapshot: makeSnapshot({ id: 'abc', name: 'Roadmap' }) })
    const bundle = buildMigrationBundle([input])
    expect(bundle.canvases).toEqual([
      { id: 'abc', name: 'Roadmap', scene: { elements: input.elements } },
    ])
  })

  it('produces an ISO createdAt from an injected clock', () => {
    const now = () => new Date('2026-01-01T12:00:00.000Z')
    const bundle = buildMigrationBundle([makeInput()], now)
    expect(bundle.createdAt).toBe('2026-01-01T12:00:00.000Z')
  })

  it('produces an empty canvases array that still parses when given no snapshots', () => {
    const bundle = buildMigrationBundle([])
    expect(bundle.canvases).toEqual([])
    expect(() => migrationBundleSchema.parse(bundle)).not.toThrow()
  })

  it('does not mutate the input array or its entries', () => {
    const inputs = [makeInput()]
    const frozenElements = inputs[0].elements
    buildMigrationBundle(inputs)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].elements).toBe(frozenElements)
  })
})
