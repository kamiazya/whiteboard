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
  type CreateDocumentRequest,
  type CreateDocumentResponse,
  createDocumentRequestSchema,
  createDocumentResponseSchema,
  type DocumentSummary,
  documentSummarySchema,
  type ExportDocumentJsonRequest,
  exportDocumentJsonRequestSchema,
  type ListDocumentsResponse,
  type ListVersionsResponse,
  type ListWorkspacesResponse,
  listDocumentsResponseSchema,
  listVersionsResponseSchema,
  listWorkspacesResponseSchema,
  type OperatorInfo,
  type OptimizeAllDocumentsResponse,
  operatorInfoSchema,
  optimizeAllDocumentsResponseSchema,
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
} from './document.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('createDocumentRequestSchema', () => {
  const valid: CreateDocumentRequest = { path: 'my-canvas', kind: 'spatial' }

  it('parses a well-formed value', () => {
    const result: CreateDocumentRequest = createDocumentRequestSchema.parse(valid)
    expect(result.path).toBe('my-canvas')
  })

  it('roundtrip preserves fields', () => {
    const result: CreateDocumentRequest = roundtrip(createDocumentRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('trims whitespace from path', () => {
    const result = createDocumentRequestSchema.parse({ path: '  canvas  ' })
    expect(result.path).toBe('canvas')
  })

  it('rejects empty path', () => {
    expect(createDocumentRequestSchema.safeParse({ path: '' }).success).toBe(false)
    expect(createDocumentRequestSchema.safeParse({ path: '   ' }).success).toBe(false)
  })

  it('accepts an explicit kind: markdown', () => {
    const result = createDocumentRequestSchema.parse({ path: 'notes', kind: 'markdown' })
    expect(result.kind).toBe('markdown')
  })

  it('defaults kind to spatial when absent — back-compat for existing callers', () => {
    const result = createDocumentRequestSchema.parse({ path: 'legacy' })
    expect(result.kind).toBe('spatial')
  })

  it('rejects an unknown kind', () => {
    expect(createDocumentRequestSchema.safeParse({ path: 'x', kind: 'bogus' }).success).toBe(false)
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
    expect(result.targetPath).toBeUndefined()
  })

  it('roundtrip with targetPath and overwrite', () => {
    const valid: RestoreVersionRequest = { targetPath: 'new-canvas', overwrite: true }
    const result: RestoreVersionRequest = roundtrip(restoreVersionRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects empty targetPath', () => {
    expect(restoreVersionRequestSchema.safeParse({ targetPath: '' }).success).toBe(false)
    expect(restoreVersionRequestSchema.safeParse({ targetPath: '   ' }).success).toBe(false)
  })
})

describe('exportDocumentJsonRequestSchema', () => {
  it('parses an empty body', () => {
    const result: ExportDocumentJsonRequest = exportDocumentJsonRequestSchema.parse({})
    expect(result.includeCustomFields).toBeUndefined()
  })

  it('roundtrip with all optional fields', () => {
    const valid: ExportDocumentJsonRequest = {
      includeCustomFields: true,
      outputPath: '/tmp/out.json',
      overwrite: false,
    }
    const result: ExportDocumentJsonRequest = roundtrip(exportDocumentJsonRequestSchema, valid)
    expect(result).toEqual(valid)
  })
})

describe('versionEntrySchema', () => {
  const valid: VersionEntry = {
    id: 'ver-1',
    path: 'my-canvas',
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
    path: 'canvas',
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
    path: 'canvas',
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

describe('createDocumentResponseSchema', () => {
  const valid: CreateDocumentResponse = { path: 'new-canvas' }

  it('parses a well-formed value', () => {
    const result: CreateDocumentResponse = createDocumentResponseSchema.parse(valid)
    expect(result.path).toBe('new-canvas')
  })

  it('roundtrip preserves path', () => {
    const result: CreateDocumentResponse = roundtrip(createDocumentResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing path', () => {
    expect(createDocumentResponseSchema.safeParse({}).success).toBe(false)
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

describe('documentSummarySchema', () => {
  const valid: DocumentSummary = {
    path: 'canvas-1',
    updatedAt: '2024-01-01T00:00:00.000Z',
    kind: 'spatial',
  }

  it('parses a well-formed value', () => {
    const result: DocumentSummary = documentSummarySchema.parse(valid)
    expect(result.path).toBe('canvas-1')
  })

  it('roundtrip preserves fields', () => {
    const result: DocumentSummary = roundtrip(documentSummarySchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing updatedAt', () => {
    expect(documentSummarySchema.safeParse({ path: 'canvas-1' }).success).toBe(false)
  })

  it('accepts an explicit kind: markdown', () => {
    const result = documentSummarySchema.parse({ ...valid, kind: 'markdown' })
    expect(result.kind).toBe('markdown')
  })

  it('leaves kind ABSENT when the row records none, instead of defaulting it to spatial', () => {
    // The default used to make "stored as spatial" and "never recorded"
    // indistinguishable to every client. A summary now withholds the claim;
    // a client that must render something decides for itself.
    const result = documentSummarySchema.parse({
      path: 'canvas-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    expect(result.kind).toBeUndefined()
  })

  it('still parses a recorded kind unchanged', () => {
    const result = documentSummarySchema.parse({
      path: 'canvas-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      kind: 'markdown',
    })
    expect(result.kind).toBe('markdown')
  })

  it('rejects an unknown kind', () => {
    expect(documentSummarySchema.safeParse({ ...valid, kind: 'bogus' }).success).toBe(false)
  })
})

describe('listDocumentsResponseSchema', () => {
  const valid: ListDocumentsResponse = {
    documents: [{ path: 'canvas-1', updatedAt: '2024-01-01T00:00:00.000Z', kind: 'spatial' }],
  }

  it('parses a well-formed value', () => {
    const result: ListDocumentsResponse = listDocumentsResponseSchema.parse(valid)
    expect(result.documents).toHaveLength(1)
  })

  it('roundtrip preserves documents', () => {
    const result: ListDocumentsResponse = roundtrip(listDocumentsResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing documents', () => {
    expect(listDocumentsResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('optimizeAllDocumentsResponseSchema', () => {
  const valid: OptimizeAllDocumentsResponse = { totalBeforeBytes: 4096, totalAfterBytes: 1024 }

  it('parses a well-formed value', () => {
    const result: OptimizeAllDocumentsResponse = optimizeAllDocumentsResponseSchema.parse(valid)
    expect(result.totalBeforeBytes).toBe(4096)
  })

  it('roundtrip preserves fields', () => {
    const result: OptimizeAllDocumentsResponse = roundtrip(
      optimizeAllDocumentsResponseSchema,
      valid,
    )
    expect(result).toEqual(valid)
  })

  it('rejects missing totalAfterBytes', () => {
    expect(optimizeAllDocumentsResponseSchema.safeParse({ totalBeforeBytes: 4096 }).success).toBe(
      false,
    )
  })

  it('rejects negative or fractional byte totals', () => {
    expect(
      optimizeAllDocumentsResponseSchema.safeParse({ totalBeforeBytes: -1, totalAfterBytes: 0 })
        .success,
    ).toBe(false)
    expect(
      optimizeAllDocumentsResponseSchema.safeParse({ totalBeforeBytes: 1.5, totalAfterBytes: 0 })
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
