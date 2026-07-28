import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApplyRowsInput } from '@kamiazya/whiteboard-canvas-ports'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../db/test-helpers.js'
import { LibsqlWorkspaceIndex } from './libsql-workspace-index.js'

function emptyInput(workspaceId: string): ApplyRowsInput {
  return {
    workspaceId,
    canvasList: [],
    facets: [],
    aliases: [],
    backlinks: [],
    aliasHistory: [],
  }
}

let tempDir: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let index: LibsqlWorkspaceIndex

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-libsql-workspace-index-test-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  index = new LibsqlWorkspaceIndex(handle.db)
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('LibsqlWorkspaceIndex', () => {
  it('returns empty results for every read method before any applyRows', async () => {
    const workspaceId = 'workspace-a'

    expect(await index.resolveAlias({ workspaceId, alias: 'home' })).toBeNull()
    expect(await index.resolveAliasHistory({ workspaceId, alias: 'old-home' })).toBeNull()
    expect(await index.listCanvases({ workspaceId })).toEqual({ rows: [] })
    expect(await index.queryFacet({ workspaceId, facet: 'kind', value: 'note' })).toEqual({
      canvasIds: [],
    })
    expect(await index.listBacklinks({ workspaceId, toCanvasId: 'canvas-1' })).toEqual({
      rows: [],
    })
  })

  it('resolves an alias written by applyRows', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      ...emptyInput(workspaceId),
      aliases: [{ alias: 'home', canvasId: 'canvas-1' }],
    })

    expect(await index.resolveAlias({ workspaceId, alias: 'home' })).toEqual({
      canvasId: 'canvas-1',
    })
    expect(await index.resolveAlias({ workspaceId, alias: 'missing' })).toBeNull()
  })

  it('resolves alias history written by applyRows', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      ...emptyInput(workspaceId),
      aliasHistory: [{ alias: 'old-home', canvasId: 'canvas-1', retiredAtMs: 42 }],
    })

    expect(await index.resolveAliasHistory({ workspaceId, alias: 'old-home' })).toEqual({
      canvasId: 'canvas-1',
    })
    expect(await index.resolveAliasHistory({ workspaceId, alias: 'missing' })).toBeNull()
  })

  it('listCanvases returns rows in insertion order', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      ...emptyInput(workspaceId),
      canvasList: [
        { canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 },
        { canvasId: 'canvas-2', title: 'Two', updatedAtMs: 2 },
        { canvasId: 'canvas-3', title: 'Three', updatedAtMs: 3 },
      ],
    })

    expect(await index.listCanvases({ workspaceId })).toEqual({
      rows: [
        { canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 },
        { canvasId: 'canvas-2', title: 'Two', updatedAtMs: 2 },
        { canvasId: 'canvas-3', title: 'Three', updatedAtMs: 3 },
      ],
    })
  })

  it('listCanvases honors limit/offset pagination', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      ...emptyInput(workspaceId),
      canvasList: [
        { canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 },
        { canvasId: 'canvas-2', title: 'Two', updatedAtMs: 2 },
        { canvasId: 'canvas-3', title: 'Three', updatedAtMs: 3 },
      ],
    })

    const page1 = await index.listCanvases({ workspaceId, limit: 2, offset: 0 })
    const page2 = await index.listCanvases({ workspaceId, limit: 2, offset: 2 })

    expect(page1.rows).toEqual([
      { canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 },
      { canvasId: 'canvas-2', title: 'Two', updatedAtMs: 2 },
    ])
    expect(page2.rows).toEqual([{ canvasId: 'canvas-3', title: 'Three', updatedAtMs: 3 }])
  })

  it('queryFacet returns canvasIds matching an exact (facet, value) pair', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      ...emptyInput(workspaceId),
      facets: [
        { facet: 'kind', value: 'note', canvasId: 'canvas-1' },
        { facet: 'kind', value: 'diagram', canvasId: 'canvas-2' },
      ],
    })

    expect(await index.queryFacet({ workspaceId, facet: 'kind', value: 'note' })).toEqual({
      canvasIds: ['canvas-1'],
    })
  })

  it('listBacklinks returns rows matching toCanvasId', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      ...emptyInput(workspaceId),
      backlinks: [
        { fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' },
        { fromCanvasId: 'canvas-3', toCanvasId: 'canvas-4' },
      ],
    })

    expect(await index.listBacklinks({ workspaceId, toCanvasId: 'canvas-1' })).toEqual({
      rows: [{ fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' }],
    })
  })

  it('isolates rows written under one workspaceId from another', async () => {
    await index.applyRows({
      workspaceId: 'workspace-a',
      canvasList: [{ canvasId: 'canvas-1', title: 'Canvas 1', updatedAtMs: 1 }],
      facets: [{ facet: 'kind', value: 'note', canvasId: 'canvas-1' }],
      aliases: [{ alias: 'home', canvasId: 'canvas-1' }],
      backlinks: [{ fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' }],
      aliasHistory: [{ alias: 'old-home', canvasId: 'canvas-1', retiredAtMs: 1 }],
    })
    // Overlapping canvasId across workspaces to prove scoping, not just distinct ids.
    await index.applyRows({
      workspaceId: 'workspace-b',
      canvasList: [{ canvasId: 'canvas-1', title: 'Other Canvas 1', updatedAtMs: 9 }],
      facets: [],
      aliases: [],
      backlinks: [],
      aliasHistory: [],
    })

    expect(await index.resolveAlias({ workspaceId: 'workspace-b', alias: 'home' })).toBeNull()
    expect(
      await index.resolveAliasHistory({ workspaceId: 'workspace-b', alias: 'old-home' }),
    ).toBeNull()
    expect(await index.listCanvases({ workspaceId: 'workspace-b' })).toEqual({
      rows: [{ canvasId: 'canvas-1', title: 'Other Canvas 1', updatedAtMs: 9 }],
    })
    expect(
      await index.queryFacet({ workspaceId: 'workspace-b', facet: 'kind', value: 'note' }),
    ).toEqual({ canvasIds: [] })
    expect(
      await index.listBacklinks({ workspaceId: 'workspace-b', toCanvasId: 'canvas-1' }),
    ).toEqual({ rows: [] })

    expect(await index.resolveAlias({ workspaceId: 'workspace-a', alias: 'home' })).toEqual({
      canvasId: 'canvas-1',
    })
  })

  it('a second applyRows fully replaces the first (no stale rows)', async () => {
    const workspaceId = 'workspace-a'
    await index.applyRows({
      workspaceId,
      canvasList: [{ canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 }],
      facets: [{ facet: 'kind', value: 'note', canvasId: 'canvas-1' }],
      aliases: [{ alias: 'home', canvasId: 'canvas-1' }],
      backlinks: [{ fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' }],
      aliasHistory: [{ alias: 'old-home', canvasId: 'canvas-1', retiredAtMs: 1 }],
    })

    await index.applyRows({
      workspaceId,
      canvasList: [{ canvasId: 'canvas-9', title: 'Nine', updatedAtMs: 9 }],
      facets: [],
      aliases: [],
      backlinks: [],
      aliasHistory: [],
    })

    expect(await index.listCanvases({ workspaceId })).toEqual({
      rows: [{ canvasId: 'canvas-9', title: 'Nine', updatedAtMs: 9 }],
    })
    expect(await index.resolveAlias({ workspaceId, alias: 'home' })).toBeNull()
    expect(await index.resolveAliasHistory({ workspaceId, alias: 'old-home' })).toBeNull()
    expect(await index.queryFacet({ workspaceId, facet: 'kind', value: 'note' })).toEqual({
      canvasIds: [],
    })
    expect(await index.listBacklinks({ workspaceId, toCanvasId: 'canvas-1' })).toEqual({
      rows: [],
    })
  })

  it('rolls back the entire five-table write when a mid-transaction insert fails', async () => {
    const workspaceId = 'workspace-atomic'

    // canvasList/facets/aliases/backlinks all insert successfully inside the
    // transaction; the LAST table (aliasHistory) gets a row with a `null`
    // `retiredAtMs`, which violates that column's real NOT NULL constraint
    // and throws mid-transaction against the actual libSQL connection — not
    // a mock. If the transaction did not roll back, the earlier four tables'
    // inserts would remain visible.
    const invalidInput = {
      workspaceId,
      canvasList: [{ canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 }],
      facets: [{ facet: 'kind', value: 'note', canvasId: 'canvas-1' }],
      aliases: [{ alias: 'home', canvasId: 'canvas-1' }],
      backlinks: [{ fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' }],
      aliasHistory: [{ alias: 'old-home', canvasId: 'canvas-1', retiredAtMs: null }],
    } as unknown as ApplyRowsInput

    await expect(index.applyRows(invalidInput)).rejects.toThrow()

    expect(await index.listCanvases({ workspaceId })).toEqual({ rows: [] })
    expect(await index.queryFacet({ workspaceId, facet: 'kind', value: 'note' })).toEqual({
      canvasIds: [],
    })
    expect(await index.resolveAlias({ workspaceId, alias: 'home' })).toBeNull()
    expect(await index.listBacklinks({ workspaceId, toCanvasId: 'canvas-1' })).toEqual({ rows: [] })
    expect(await index.resolveAliasHistory({ workspaceId, alias: 'old-home' })).toBeNull()
  })

  it('propagates a driver error on read after the connection is closed', async () => {
    await handle.dispose()
    await expect(
      index.resolveAlias({ workspaceId: 'workspace-a', alias: 'home' }),
    ).rejects.toThrow()
  })

  it('migration creates indexes on the facets and backlinks lookup columns', async () => {
    const facetsIndexes = await sql<{
      name: string
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspaceIndexFacets'`.execute(
      handle.db,
    )
    const backlinksIndexes = await sql<{
      name: string
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspaceIndexBacklinks'`.execute(
      handle.db,
    )

    expect(facetsIndexes.rows.some((row) => row.name === 'workspaceIndexFacets_lookup')).toBe(true)
    expect(backlinksIndexes.rows.some((row) => row.name === 'workspaceIndexBacklinks_lookup')).toBe(
      true,
    )
  })

  it('queryFacet returns correct results at scale across two workspaces and facet pairs', async () => {
    const workspaceA = 'workspace-scale-a'
    const workspaceB = 'workspace-scale-b'

    const buildFacets = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        facet: 'kind',
        value: i % 2 === 0 ? 'note' : 'diagram',
        canvasId: `${prefix}-canvas-${i}`,
      }))

    await index.applyRows({ ...emptyInput(workspaceA), facets: buildFacets('a', 60) })
    await index.applyRows({ ...emptyInput(workspaceB), facets: buildFacets('b', 60) })

    const notesA = await index.queryFacet({ workspaceId: workspaceA, facet: 'kind', value: 'note' })
    const diagramsB = await index.queryFacet({
      workspaceId: workspaceB,
      facet: 'kind',
      value: 'diagram',
    })

    expect(notesA.canvasIds).toHaveLength(30)
    expect(notesA.canvasIds.every((id) => id.startsWith('a-canvas-'))).toBe(true)
    expect(diagramsB.canvasIds).toHaveLength(30)
    expect(diagramsB.canvasIds.every((id) => id.startsWith('b-canvas-'))).toBe(true)
  })
})
