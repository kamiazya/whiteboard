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
      { facet: 'view', value: 'kanban/1', canvasId: PROJECT_ID },
    ])
    for (const row of rows) expect(() => facetIndexRowSchema.parse(row)).not.toThrow()
  })

  test('returns no rows for a canvas with no facets', () => {
    expect(deriveFacetIndexRows([{ canvasId: NOTES_ID, updatedAtMs: 0 }])).toEqual([])
  })

  test('indexes a issue/1 extension facet payload as existence + deep per-field rows', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: { 'issue/1': { status: 'open', assignees: ['alice'] } },
      },
    ])

    expect(rows).toEqual([
      { facet: 'facets.issue/1', value: '', canvasId: NOTES_ID },
      { facet: 'facets.issue/1.assignees', value: 'alice', canvasId: NOTES_ID },
      { facet: 'facets.issue/1.status', value: 'open', canvasId: NOTES_ID },
    ])
    for (const row of rows) expect(() => facetIndexRowSchema.parse(row)).not.toThrow()
  })

  test('emits one deep row per array element for assignees and labels, plus scalar fields', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: {
          'issue/1': {
            status: 'open',
            priority: 'high',
            assignees: ['alice', 'bob'],
            labels: ['bug'],
            due: '2026-08-01T00:00:00.000Z',
            summary: 'fix it',
          },
        },
      },
    ])

    expect(rows).toEqual(
      expect.arrayContaining([
        { facet: 'facets.issue/1', value: '', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.status', value: 'open', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.priority', value: 'high', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.assignees', value: 'alice', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.assignees', value: 'bob', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.labels', value: 'bug', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.due', value: '2026-08-01T00:00:00.000Z', canvasId: NOTES_ID },
        { facet: 'facets.issue/1.summary', value: 'fix it', canvasId: NOTES_ID },
      ]),
    )
    // existence + status + priority + due + summary (4 scalars) + 2 assignees + 1 label
    expect(rows).toHaveLength(1 + 4 + 2 + 1)
    for (const row of rows) expect(() => facetIndexRowSchema.parse(row)).not.toThrow()
  })

  test('emits no deep rows for absent optional fields or empty arrays', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: { 'issue/1': { status: 'open', assignees: [], labels: [] } },
      },
    ])

    expect(rows).toEqual([
      { facet: 'facets.issue/1', value: '', canvasId: NOTES_ID },
      { facet: 'facets.issue/1.status', value: 'open', canvasId: NOTES_ID },
    ])
  })

  test('treats non-issue/1 extension domains as existence-only (no regression)', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: { 'kanban/1': { columns: ['todo', 'done'] } },
      },
    ])

    expect(rows).toEqual([{ facet: 'facets.kanban/1', value: '', canvasId: NOTES_ID }])
  })

  test('falls back to existence-only row when issue/1 payload is not an object (never throws)', () => {
    for (const malformed of ['open', 42, null]) {
      const rows = deriveFacetIndexRows([
        { canvasId: NOTES_ID, updatedAtMs: 0, extensionFacets: { 'issue/1': malformed } },
      ])
      expect(rows).toEqual([{ facet: 'facets.issue/1', value: '', canvasId: NOTES_ID }])
    }
  })

  test('falls back to existence-only row when issue/1 payload is missing required status (never throws)', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: { 'issue/1': { assignees: ['alice'] } },
      },
    ])
    expect(rows).toEqual([{ facet: 'facets.issue/1', value: '', canvasId: NOTES_ID }])
  })

  test('falls back to existence-only row when issue/1 payload has wrong field types (never throws)', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: { 'issue/1': { status: 42, assignees: 'not-an-array' } },
      },
    ])
    expect(rows).toEqual([{ facet: 'facets.issue/1', value: '', canvasId: NOTES_ID }])
  })

  test('falls back to existence-only row when issue/1 payload has extra unknown keys (strict rejection, never throws)', () => {
    const rows = deriveFacetIndexRows([
      {
        canvasId: NOTES_ID,
        updatedAtMs: 0,
        extensionFacets: { 'issue/1': { status: 'open', extra: 'nope' } },
      },
    ])
    expect(rows).toEqual([{ facet: 'facets.issue/1', value: '', canvasId: NOTES_ID }])
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
