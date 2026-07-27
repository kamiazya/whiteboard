import { describe, expect, it } from 'vitest'
import { InMemoryWorkspaceIndex } from './in-memory-workspace-index.js'

describe('InMemoryWorkspaceIndex', () => {
  it('isolates rows written under one workspaceId from queries under another', async () => {
    const index = new InMemoryWorkspaceIndex()

    await index.applyRows({
      workspaceId: 'workspace-a',
      canvasList: [{ canvasId: 'canvas-1', title: 'Canvas 1', updatedAtMs: 1 }],
      facets: [{ facet: 'kind', value: 'note', canvasId: 'canvas-1' }],
      aliases: [{ alias: 'home', canvasId: 'canvas-1' }],
      backlinks: [{ fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' }],
      aliasHistory: [{ alias: 'old-home', canvasId: 'canvas-1', retiredAtMs: 1 }],
    })

    expect(await index.resolveAlias({ workspaceId: 'workspace-b', alias: 'home' })).toBeNull()
    expect(
      await index.resolveAliasHistory({ workspaceId: 'workspace-b', alias: 'old-home' }),
    ).toBeNull()
    expect(await index.listCanvases({ workspaceId: 'workspace-b' })).toEqual({ rows: [] })
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

  it('resolveAlias / resolveAliasHistory: hit and miss', async () => {
    const index = new InMemoryWorkspaceIndex()
    await index.applyRows({
      workspaceId: 'workspace-a',
      canvasList: [],
      facets: [],
      aliases: [{ alias: 'home', canvasId: 'canvas-1' }],
      backlinks: [],
      aliasHistory: [{ alias: 'old-home', canvasId: 'canvas-1', retiredAtMs: 1 }],
    })

    expect(await index.resolveAlias({ workspaceId: 'workspace-a', alias: 'home' })).toEqual({
      canvasId: 'canvas-1',
    })
    expect(await index.resolveAlias({ workspaceId: 'workspace-a', alias: 'missing' })).toBeNull()
    expect(
      await index.resolveAliasHistory({ workspaceId: 'workspace-a', alias: 'old-home' }),
    ).toEqual({ canvasId: 'canvas-1' })
  })

  it('listCanvases honors limit/offset', async () => {
    const index = new InMemoryWorkspaceIndex()
    await index.applyRows({
      workspaceId: 'workspace-a',
      canvasList: [
        { canvasId: 'canvas-1', title: 'One', updatedAtMs: 1 },
        { canvasId: 'canvas-2', title: 'Two', updatedAtMs: 2 },
        { canvasId: 'canvas-3', title: 'Three', updatedAtMs: 3 },
      ],
      facets: [],
      aliases: [],
      backlinks: [],
      aliasHistory: [],
    })

    const result = await index.listCanvases({ workspaceId: 'workspace-a', limit: 1, offset: 1 })
    expect(result.rows).toEqual([{ canvasId: 'canvas-2', title: 'Two', updatedAtMs: 2 }])
  })

  it('queryFacet returns matching canvasIds', async () => {
    const index = new InMemoryWorkspaceIndex()
    await index.applyRows({
      workspaceId: 'workspace-a',
      canvasList: [],
      facets: [
        { facet: 'kind', value: 'note', canvasId: 'canvas-1' },
        { facet: 'kind', value: 'diagram', canvasId: 'canvas-2' },
      ],
      aliases: [],
      backlinks: [],
      aliasHistory: [],
    })

    expect(
      await index.queryFacet({ workspaceId: 'workspace-a', facet: 'kind', value: 'note' }),
    ).toEqual({ canvasIds: ['canvas-1'] })
  })

  it('listBacklinks returns rows by toCanvasId', async () => {
    const index = new InMemoryWorkspaceIndex()
    await index.applyRows({
      workspaceId: 'workspace-a',
      canvasList: [],
      facets: [],
      aliases: [],
      backlinks: [
        { fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' },
        { fromCanvasId: 'canvas-3', toCanvasId: 'canvas-4' },
      ],
      aliasHistory: [],
    })

    expect(
      await index.listBacklinks({ workspaceId: 'workspace-a', toCanvasId: 'canvas-1' }),
    ).toEqual({
      rows: [{ fromCanvasId: 'canvas-2', toCanvasId: 'canvas-1' }],
    })
  })
})
