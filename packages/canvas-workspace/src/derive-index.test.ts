import {
  aliasHistoryRowSchema,
  aliasResolutionRowSchema,
  applyRowsInputSchema,
  backlinkRowSchema,
  canvasListRowSchema,
  facetIndexRowSchema,
} from '@kamiazya/whiteboard-canvas-ports'
import { describe, expect, test } from 'vitest'
import {
  deriveAliasHistoryRows,
  deriveAliasResolutionRows,
  deriveBacklinkRows,
  deriveCanvasListRows,
  deriveFacetIndexRows,
  deriveWorkspaceIndexRows,
} from './derive-index.js'
import {
  buildFixtureWorkspace,
  DIAGRAM_ID,
  NOTES_ID,
  PROJECT_ID,
} from './test-utils/index-fixtures.js'

describe('deriveFacetIndexRows', () => {
  test('derives exact (facet, value, canvasId) rows sorted deterministically', () => {
    const { canvases } = buildFixtureWorkspace()

    const rows = deriveFacetIndexRows(canvases)

    expect(rows).toEqual([
      { facet: 'facets.kanban/1', value: '', canvasId: PROJECT_ID },
      { facet: 'tags', value: 'inbox', canvasId: NOTES_ID },
      { facet: 'tags', value: 'urgent', canvasId: NOTES_ID },
      { facet: 'type', value: 'doc', canvasId: NOTES_ID },
      { facet: 'type', value: 'doc', canvasId: PROJECT_ID },
      { facet: 'type', value: 'spatial', canvasId: DIAGRAM_ID },
    ])
    for (const row of rows) expect(() => facetIndexRowSchema.parse(row)).not.toThrow()
  })

  test('returns no rows for a canvas with no facets', () => {
    expect(deriveFacetIndexRows([{ canvasId: NOTES_ID, updatedAtMs: 0 }])).toEqual([])
  })
})

describe('deriveCanvasListRows', () => {
  test('falls back title from frontmatter to leaf segment', () => {
    const { tree, canvases } = buildFixtureWorkspace()

    const rows = deriveCanvasListRows(tree, canvases)

    expect(rows).toEqual([
      { canvasId: NOTES_ID, title: 'notes', updatedAtMs: 1_000 },
      { canvasId: PROJECT_ID, title: 'Whiteboard Project', updatedAtMs: 2_000 },
      { canvasId: DIAGRAM_ID, title: 'diagram', updatedAtMs: 3_000 },
    ])
    for (const row of rows) expect(() => canvasListRowSchema.parse(row)).not.toThrow()
  })

  test('falls back to empty title when no tree node and no frontmatter title', () => {
    const { tree } = buildFixtureWorkspace()
    const rows = deriveCanvasListRows(tree, [{ canvasId: 'orphan', updatedAtMs: 5 }])
    expect(rows).toEqual([{ canvasId: 'orphan', title: '', updatedAtMs: 5 }])
  })
})

describe('deriveAliasResolutionRows', () => {
  test('maps every tree node alias (root-to-leaf segment join) to its canvasId', () => {
    const { tree } = buildFixtureWorkspace()

    const rows = deriveAliasResolutionRows(tree)

    expect(rows).toContainEqual({ alias: 'notes', canvasId: NOTES_ID })
    expect(rows).toContainEqual({ alias: 'projects/whiteboard', canvasId: PROJECT_ID })
    expect(rows).toContainEqual({ alias: 'projects/diagram', canvasId: DIAGRAM_ID })
    for (const row of rows) expect(() => aliasResolutionRowSchema.parse(row)).not.toThrow()
  })
})

describe('deriveBacklinkRows', () => {
  test('matches extractBacklinks output concatenated across canvases, dedup preserved', () => {
    const { canvases } = buildFixtureWorkspace()

    const rows = deriveBacklinkRows(canvases)

    expect(rows).toEqual([
      { fromCanvasId: NOTES_ID, toCanvasId: PROJECT_ID },
      { fromCanvasId: PROJECT_ID, toCanvasId: DIAGRAM_ID },
    ])
    for (const row of rows) expect(() => backlinkRowSchema.parse(row)).not.toThrow()
  })

  test('skips canvases with no resolved body', () => {
    expect(deriveBacklinkRows([{ canvasId: DIAGRAM_ID, updatedAtMs: 0 }])).toEqual([])
  })
})

describe('deriveAliasHistoryRows', () => {
  test('returns an empty, DTO-typed set (tree retains no history yet)', () => {
    const rows = deriveAliasHistoryRows()
    expect(rows).toEqual([])
    for (const row of rows) expect(() => aliasHistoryRowSchema.parse(row)).not.toThrow()
  })
})

describe('deriveWorkspaceIndexRows', () => {
  test('assembles all five row-sets and validates against applyRowsInputSchema', () => {
    const { tree, canvases } = buildFixtureWorkspace()

    const result = deriveWorkspaceIndexRows({ workspaceId: 'ws-1', tree, canvases })

    expect(result.canvasList).toHaveLength(3)
    expect(result.facets.length).toBeGreaterThan(0)
    expect(result.aliases).toHaveLength(4) // notes + projects folder + whiteboard + diagram
    expect(result.backlinks).toHaveLength(2)
    expect(result.aliasHistory).toEqual([])
    expect(() => applyRowsInputSchema.parse(result)).not.toThrow()
  })
})
