import { describe, expect, it } from 'vitest'
import {
  aliasHistoryRowSchema,
  aliasResolutionRowSchema,
  applyRowsInputSchema,
  backlinkRowSchema,
  canvasListRowSchema,
  facetIndexRowSchema,
  listBacklinksInputSchema,
  listCanvasesInputSchema,
  queryFacetInputSchema,
  resolveAliasHistoryInputSchema,
  resolveAliasInputSchema,
} from './workspace-index.js'

const canvasId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherCanvasId = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

describe('facetIndexRowSchema', () => {
  it('accepts a valid row', () => {
    expect(facetIndexRowSchema.safeParse({ facet: 'type', value: 'note', canvasId }).success).toBe(
      true,
    )
  })
  it('rejects an empty facet name and extra keys', () => {
    expect(facetIndexRowSchema.safeParse({ facet: '', value: 'note', canvasId }).success).toBe(
      false,
    )
    expect(
      facetIndexRowSchema.safeParse({ facet: 'type', value: 'note', canvasId, extra: 1 }).success,
    ).toBe(false)
  })
})

describe('canvasListRowSchema', () => {
  it('accepts a valid row', () => {
    expect(
      canvasListRowSchema.safeParse({ canvasId, title: 'Untitled', updatedAtMs: 0 }).success,
    ).toBe(true)
  })
  it('rejects an invalid canvasId and a negative updatedAtMs', () => {
    expect(
      canvasListRowSchema.safeParse({ canvasId: 'not-a-ulid', title: 'x', updatedAtMs: 0 }).success,
    ).toBe(false)
    expect(canvasListRowSchema.safeParse({ canvasId, title: 'x', updatedAtMs: -1 }).success).toBe(
      false,
    )
  })
})

describe('aliasResolutionRowSchema', () => {
  it('accepts a valid row', () => {
    expect(aliasResolutionRowSchema.safeParse({ alias: 'home', canvasId }).success).toBe(true)
  })
  it('rejects an empty alias', () => {
    expect(aliasResolutionRowSchema.safeParse({ alias: '', canvasId }).success).toBe(false)
  })
})

describe('backlinkRowSchema', () => {
  it('accepts a valid row', () => {
    expect(
      backlinkRowSchema.safeParse({ fromCanvasId: canvasId, toCanvasId: otherCanvasId }).success,
    ).toBe(true)
  })
  it('rejects an invalid toCanvasId', () => {
    expect(
      backlinkRowSchema.safeParse({ fromCanvasId: canvasId, toCanvasId: 'not-a-ulid' }).success,
    ).toBe(false)
  })
})

describe('aliasHistoryRowSchema', () => {
  it('accepts a valid row', () => {
    expect(
      aliasHistoryRowSchema.safeParse({ alias: 'home', canvasId, retiredAtMs: 0 }).success,
    ).toBe(true)
  })
  it('rejects a negative retiredAtMs', () => {
    expect(
      aliasHistoryRowSchema.safeParse({ alias: 'home', canvasId, retiredAtMs: -1 }).success,
    ).toBe(false)
  })
})

describe('WorkspaceIndex input DTOs carry workspaceId (per-call isolation)', () => {
  it('applyRows accepts a valid workspaceId and rejects a missing/empty one', () => {
    const base = {
      canvasList: [] as unknown[],
      facets: [] as unknown[],
      aliases: [] as unknown[],
      backlinks: [] as unknown[],
      aliasHistory: [] as unknown[],
    }
    expect(applyRowsInputSchema.safeParse({ workspaceId: 'workspace-a', ...base }).success).toBe(
      true,
    )
    expect(applyRowsInputSchema.safeParse({ ...base }).success).toBe(false)
    expect(applyRowsInputSchema.safeParse({ workspaceId: '', ...base }).success).toBe(false)
  })

  it('resolveAlias accepts a valid workspaceId and rejects a missing one', () => {
    expect(
      resolveAliasInputSchema.safeParse({ workspaceId: 'workspace-a', alias: 'home' }).success,
    ).toBe(true)
    expect(resolveAliasInputSchema.safeParse({ alias: 'home' }).success).toBe(false)
  })

  it('resolveAliasHistory accepts a valid workspaceId and rejects a missing one', () => {
    expect(
      resolveAliasHistoryInputSchema.safeParse({ workspaceId: 'workspace-a', alias: 'home' })
        .success,
    ).toBe(true)
    expect(resolveAliasHistoryInputSchema.safeParse({ alias: 'home' }).success).toBe(false)
  })

  it('listCanvases accepts a valid workspaceId and rejects a missing one', () => {
    expect(listCanvasesInputSchema.safeParse({ workspaceId: 'workspace-a' }).success).toBe(true)
    expect(listCanvasesInputSchema.safeParse({}).success).toBe(false)
    expect(
      listCanvasesInputSchema.safeParse({ workspaceId: 'workspace-a', limit: 0 }).success,
    ).toBe(false)
    expect(
      listCanvasesInputSchema.safeParse({ workspaceId: 'workspace-a', offset: -1 }).success,
    ).toBe(false)
  })

  it('queryFacet accepts a valid workspaceId and rejects a missing one', () => {
    expect(
      queryFacetInputSchema.safeParse({ workspaceId: 'workspace-a', facet: 'type', value: 'note' })
        .success,
    ).toBe(true)
    expect(queryFacetInputSchema.safeParse({ facet: 'type', value: 'note' }).success).toBe(false)
  })

  it('listBacklinks accepts a valid workspaceId and rejects a missing one', () => {
    expect(
      listBacklinksInputSchema.safeParse({ workspaceId: 'workspace-a', toCanvasId: canvasId })
        .success,
    ).toBe(true)
    expect(listBacklinksInputSchema.safeParse({ toCanvasId: canvasId }).success).toBe(false)
  })
})
