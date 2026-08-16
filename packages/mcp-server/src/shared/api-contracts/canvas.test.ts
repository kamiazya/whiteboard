/**
 * Roundtrip serialization tests for the canvas api-contract schemas.
 *
 * Each test verifies three invariants:
 *   1. A well-formed value parses successfully.
 *   2. JSON stringify → parse → schema.parse produces an equal result
 *      (no field drift through the wire format).
 *   3. A malformed / missing-required value is rejected by safeParse.
 *
 * z.infer type alignment is checked at the TypeScript level by annotating
 * parsed results with the exported type aliases.
 */
import { describe, expect, it } from 'vitest'
import {
  type CanvasSummary,
  type CreateCanvasRequest,
  type CreateCanvasResponse,
  canvasSummarySchema,
  createCanvasRequestSchema,
  createCanvasResponseSchema,
  type ExportCanvasJsonRequest,
  exportCanvasJsonRequestSchema,
  type ListCanvasesResponse,
  type ListVersionsResponse,
  type ListWorkspacesResponse,
  listCanvasesResponseSchema,
  listVersionsResponseSchema,
  listWorkspacesResponseSchema,
  type OperatorInfo,
  type OptimizeAllCanvasesResponse,
  operatorInfoSchema,
  optimizeAllCanvasesResponseSchema,
  type PruneSandwichedVersionsResponse,
  type PurgeResult,
  pruneSandwichedVersionsResponseSchema,
  purgeResultSchema,
  type RestoreVersionRequest,
  restoreVersionRequestSchema,
  type SaveVersionRequest,
  type SaveVersionResponse,
  type SetNameRequest,
  type SetPinnedRequest,
  saveVersionRequestSchema,
  saveVersionResponseSchema,
  setNameRequestSchema,
  setPinnedRequestSchema,
  type VersionEntry,
  versionEntrySchema,
  type WorkspaceSummary,
  workspaceSummarySchema,
} from './canvas.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('createCanvasRequestSchema', () => {
  const valid: CreateCanvasRequest = { slug: 'my-canvas', kind: 'spatial' }

  it('parses a well-formed value', () => {
    const result: CreateCanvasRequest = createCanvasRequestSchema.parse(valid)
    expect(result.slug).toBe('my-canvas')
  })

  it('roundtrip preserves fields', () => {
    const result: CreateCanvasRequest = roundtrip(createCanvasRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('trims whitespace from slug', () => {
    const result = createCanvasRequestSchema.parse({ slug: '  canvas  ' })
    expect(result.slug).toBe('canvas')
  })

  it('rejects empty slug', () => {
    expect(createCanvasRequestSchema.safeParse({ slug: '' }).success).toBe(false)
    expect(createCanvasRequestSchema.safeParse({ slug: '   ' }).success).toBe(false)
  })

  it('accepts an explicit kind: markdown', () => {
    const result = createCanvasRequestSchema.parse({ slug: 'notes', kind: 'markdown' })
    expect(result.kind).toBe('markdown')
  })

  it('defaults kind to spatial when absent — back-compat for existing callers', () => {
    const result = createCanvasRequestSchema.parse({ slug: 'legacy' })
    expect(result.kind).toBe('spatial')
  })

  it('rejects an unknown kind', () => {
    expect(createCanvasRequestSchema.safeParse({ slug: 'x', kind: 'bogus' }).success).toBe(false)
  })
})

describe('setNameRequestSchema', () => {
  it('parses a non-empty name', () => {
    const result: SetNameRequest = setNameRequestSchema.parse({ name: 'My Canvas' })
    expect(result.name).toBe('My Canvas')
  })

  it('parses an empty string (delete-name semantics)', () => {
    const result: SetNameRequest = setNameRequestSchema.parse({ name: '' })
    expect(result.name).toBe('')
  })

  it('roundtrip preserves name', () => {
    const valid: SetNameRequest = { name: 'My Canvas' }
    const result: SetNameRequest = roundtrip(setNameRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing name', () => {
    expect(setNameRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('setPinnedRequestSchema', () => {
  it('parses pinned: true', () => {
    const result: SetPinnedRequest = setPinnedRequestSchema.parse({ pinned: true })
    expect(result.pinned).toBe(true)
  })

  it('roundtrip preserves pinned: false', () => {
    const valid: SetPinnedRequest = { pinned: false }
    const result: SetPinnedRequest = roundtrip(setPinnedRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing pinned', () => {
    expect(setPinnedRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('operatorInfoSchema', () => {
  const valid: OperatorInfo = { kind: 'ai', peerId: 'peer-1' }

  it('parses a well-formed value', () => {
    const result: OperatorInfo = operatorInfoSchema.parse(valid)
    expect(result.kind).toBe('ai')
  })

  it('roundtrip with all optional fields', () => {
    const full: OperatorInfo = {
      kind: 'human',
      peerId: 'peer-2',
      displayName: 'Alice',
      agentId: 'agent-x',
      workspaceId: 'ws-1',
    }
    const result: OperatorInfo = roundtrip(operatorInfoSchema, full)
    expect(result).toEqual(full)
  })

  it('rejects invalid kind', () => {
    expect(operatorInfoSchema.safeParse({ kind: 'bot', peerId: 'p' }).success).toBe(false)
  })

  it('rejects empty peerId', () => {
    expect(operatorInfoSchema.safeParse({ kind: 'ai', peerId: '' }).success).toBe(false)
  })
})

describe('saveVersionRequestSchema', () => {
  it('parses an empty body', () => {
    const result: SaveVersionRequest = saveVersionRequestSchema.parse({})
    expect(result.label).toBeUndefined()
  })

  it('roundtrip with label and operator', () => {
    const valid: SaveVersionRequest = {
      label: 'v1.0',
      operator: { kind: 'human', peerId: 'peer-1' },
    }
    const result: SaveVersionRequest = roundtrip(saveVersionRequestSchema, valid)
    expect(result).toEqual(valid)
  })
})

describe('restoreVersionRequestSchema', () => {
  it('parses an empty body', () => {
    const result: RestoreVersionRequest = restoreVersionRequestSchema.parse({})
    expect(result.targetSlug).toBeUndefined()
  })

  it('roundtrip with targetSlug and overwrite', () => {
    const valid: RestoreVersionRequest = { targetSlug: 'new-canvas', overwrite: true }
    const result: RestoreVersionRequest = roundtrip(restoreVersionRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects empty targetSlug', () => {
    expect(restoreVersionRequestSchema.safeParse({ targetSlug: '' }).success).toBe(false)
    expect(restoreVersionRequestSchema.safeParse({ targetSlug: '   ' }).success).toBe(false)
  })
})

describe('exportCanvasJsonRequestSchema', () => {
  it('parses an empty body', () => {
    const result: ExportCanvasJsonRequest = exportCanvasJsonRequestSchema.parse({})
    expect(result.includeCustomFields).toBeUndefined()
  })

  it('roundtrip with all optional fields', () => {
    const valid: ExportCanvasJsonRequest = {
      includeCustomFields: true,
      outputPath: '/tmp/out.json',
      overwrite: false,
    }
    const result: ExportCanvasJsonRequest = roundtrip(exportCanvasJsonRequestSchema, valid)
    expect(result).toEqual(valid)
  })
})

describe('versionEntrySchema', () => {
  const valid: VersionEntry = {
    id: 'ver-1',
    slug: 'my-canvas',
    createdAt: '2024-01-01T00:00:00.000Z',
    elementCount: 42,
    auto: false,
    hasThumbnail: true,
    branchName: 'main',
  }

  it('parses a well-formed value', () => {
    const result: VersionEntry = versionEntrySchema.parse(valid)
    expect(result.id).toBe('ver-1')
  })

  it('roundtrip preserves all fields', () => {
    const withOptionals: VersionEntry = {
      ...valid,
      label: 'Checkpoint',
      operator: { kind: 'ai', peerId: 'agent-1' },
    }
    const result: VersionEntry = roundtrip(versionEntrySchema, withOptionals)
    expect(result).toEqual(withOptionals)
  })

  it('rejects non-finite elementCount', () => {
    expect(versionEntrySchema.safeParse({ ...valid, elementCount: Infinity }).success).toBe(false)
    expect(versionEntrySchema.safeParse({ ...valid, elementCount: NaN }).success).toBe(false)
  })

  it('rejects missing branchName', () => {
    const { branchName: _omit, ...missing } = valid
    expect(versionEntrySchema.safeParse(missing).success).toBe(false)
  })
})

describe('listVersionsResponseSchema', () => {
  const entry: VersionEntry = {
    id: 'ver-1',
    slug: 'canvas',
    createdAt: '2024-01-01T00:00:00.000Z',
    elementCount: 1,
    auto: true,
    hasThumbnail: false,
    branchName: 'main',
  }
  const valid: ListVersionsResponse = { versions: [entry] }

  it('parses a well-formed value', () => {
    const result: ListVersionsResponse = listVersionsResponseSchema.parse(valid)
    expect(result.versions).toHaveLength(1)
  })

  it('roundtrip preserves versions array', () => {
    const result: ListVersionsResponse = roundtrip(listVersionsResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing versions', () => {
    expect(listVersionsResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('saveVersionResponseSchema', () => {
  const entry: VersionEntry = {
    id: 'ver-2',
    slug: 'canvas',
    createdAt: '2024-06-01T00:00:00.000Z',
    elementCount: 5,
    auto: false,
    hasThumbnail: true,
    branchName: 'feature',
  }
  const valid: SaveVersionResponse = { version: entry }

  it('parses a well-formed value', () => {
    const result: SaveVersionResponse = saveVersionResponseSchema.parse(valid)
    expect(result.version.id).toBe('ver-2')
  })

  it('roundtrip preserves version', () => {
    const result: SaveVersionResponse = roundtrip(saveVersionResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing version', () => {
    expect(saveVersionResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('createCanvasResponseSchema', () => {
  const valid: CreateCanvasResponse = { slug: 'new-canvas' }

  it('parses a well-formed value', () => {
    const result: CreateCanvasResponse = createCanvasResponseSchema.parse(valid)
    expect(result.slug).toBe('new-canvas')
  })

  it('roundtrip preserves slug', () => {
    const result: CreateCanvasResponse = roundtrip(createCanvasResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing slug', () => {
    expect(createCanvasResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('workspaceSummarySchema', () => {
  const valid: WorkspaceSummary = { workspaceId: 'ws-abc' }

  it('parses a well-formed value', () => {
    const result: WorkspaceSummary = workspaceSummarySchema.parse(valid)
    expect(result.workspaceId).toBe('ws-abc')
  })

  it('roundtrip preserves fields', () => {
    const result: WorkspaceSummary = roundtrip(workspaceSummarySchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing workspaceId', () => {
    expect(workspaceSummarySchema.safeParse({}).success).toBe(false)
  })
})

describe('listWorkspacesResponseSchema', () => {
  const valid: ListWorkspacesResponse = { workspaces: [{ workspaceId: 'ws-1' }] }

  it('parses a well-formed value', () => {
    const result: ListWorkspacesResponse = listWorkspacesResponseSchema.parse(valid)
    expect(result.workspaces).toHaveLength(1)
  })

  it('roundtrip preserves workspaces', () => {
    const result: ListWorkspacesResponse = roundtrip(listWorkspacesResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing workspaces', () => {
    expect(listWorkspacesResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('canvasSummarySchema', () => {
  const valid: CanvasSummary = {
    slug: 'canvas-1',
    updatedAt: '2024-01-01T00:00:00.000Z',
    kind: 'spatial',
  }

  it('parses a well-formed value', () => {
    const result: CanvasSummary = canvasSummarySchema.parse(valid)
    expect(result.slug).toBe('canvas-1')
  })

  it('roundtrip preserves fields', () => {
    const result: CanvasSummary = roundtrip(canvasSummarySchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing updatedAt', () => {
    expect(canvasSummarySchema.safeParse({ slug: 'canvas-1' }).success).toBe(false)
  })

  it('accepts an explicit kind: markdown', () => {
    const result = canvasSummarySchema.parse({ ...valid, kind: 'markdown' })
    expect(result.kind).toBe('markdown')
  })

  it('defaults kind to spatial when absent — back-compat for rows stored before this change', () => {
    const result = canvasSummarySchema.parse({
      slug: 'canvas-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    expect(result.kind).toBe('spatial')
  })

  it('rejects an unknown kind', () => {
    expect(canvasSummarySchema.safeParse({ ...valid, kind: 'bogus' }).success).toBe(false)
  })
})

describe('listCanvasesResponseSchema', () => {
  const valid: ListCanvasesResponse = {
    canvases: [{ slug: 'canvas-1', updatedAt: '2024-01-01T00:00:00.000Z', kind: 'spatial' }],
  }

  it('parses a well-formed value', () => {
    const result: ListCanvasesResponse = listCanvasesResponseSchema.parse(valid)
    expect(result.canvases).toHaveLength(1)
  })

  it('roundtrip preserves canvases', () => {
    const result: ListCanvasesResponse = roundtrip(listCanvasesResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing canvases', () => {
    expect(listCanvasesResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('optimizeAllCanvasesResponseSchema', () => {
  const valid: OptimizeAllCanvasesResponse = { totalBeforeBytes: 4096, totalAfterBytes: 1024 }

  it('parses a well-formed value', () => {
    const result: OptimizeAllCanvasesResponse = optimizeAllCanvasesResponseSchema.parse(valid)
    expect(result.totalBeforeBytes).toBe(4096)
  })

  it('roundtrip preserves fields', () => {
    const result: OptimizeAllCanvasesResponse = roundtrip(optimizeAllCanvasesResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing totalAfterBytes', () => {
    expect(optimizeAllCanvasesResponseSchema.safeParse({ totalBeforeBytes: 4096 }).success).toBe(
      false,
    )
  })

  it('rejects negative or fractional byte totals', () => {
    expect(
      optimizeAllCanvasesResponseSchema.safeParse({ totalBeforeBytes: -1, totalAfterBytes: 0 })
        .success,
    ).toBe(false)
    expect(
      optimizeAllCanvasesResponseSchema.safeParse({ totalBeforeBytes: 1.5, totalAfterBytes: 0 })
        .success,
    ).toBe(false)
  })
})

describe('pruneSandwichedVersionsResponseSchema', () => {
  const valid: PruneSandwichedVersionsResponse = { totalDeleted: 3 }

  it('parses a well-formed value', () => {
    const result: PruneSandwichedVersionsResponse =
      pruneSandwichedVersionsResponseSchema.parse(valid)
    expect(result.totalDeleted).toBe(3)
  })

  it('roundtrip preserves fields', () => {
    const result: PruneSandwichedVersionsResponse = roundtrip(
      pruneSandwichedVersionsResponseSchema,
      valid,
    )
    expect(result).toEqual(valid)
  })

  it('rejects missing totalDeleted', () => {
    expect(pruneSandwichedVersionsResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a negative or fractional deletion count', () => {
    expect(pruneSandwichedVersionsResponseSchema.safeParse({ totalDeleted: -2 }).success).toBe(
      false,
    )
    expect(pruneSandwichedVersionsResponseSchema.safeParse({ totalDeleted: 0.5 }).success).toBe(
      false,
    )
  })
})

describe('purgeResultSchema', () => {
  const valid: PurgeResult = { purgedCount: 2, purgedBytes: 4096 }

  it('parses a well-formed value', () => {
    const result: PurgeResult = purgeResultSchema.parse(valid)
    expect(result.purgedCount).toBe(2)
  })

  it('roundtrip preserves fields', () => {
    const result: PurgeResult = roundtrip(purgeResultSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing purgedBytes', () => {
    expect(purgeResultSchema.safeParse({ purgedCount: 2 }).success).toBe(false)
  })

  it('rejects negative or fractional counts and byte totals', () => {
    expect(purgeResultSchema.safeParse({ purgedCount: -1, purgedBytes: 0 }).success).toBe(false)
    expect(purgeResultSchema.safeParse({ purgedCount: 0, purgedBytes: 0.5 }).success).toBe(false)
  })
})
