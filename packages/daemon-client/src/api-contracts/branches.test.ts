/**
 * Roundtrip serialization tests for the branches api-contract schemas.
 *
 * Each test verifies three invariants:
 *   1. A well-formed value parses successfully.
 *   2. JSON stringify → parse → schema.parse produces an equal result
 *      (no field drift through the wire format).
 *   3. A malformed / missing-required value is rejected by safeParse.
 *
 * The z.infer type alignment is checked at the TypeScript level: the parsed
 * result is annotated with the exported type so tsc catches any drift between
 * the schema and the exported alias.
 */
import type { MergeBadge } from '@kamiazya/whiteboard-history'
import { describe, expect, it } from 'vitest'
import {
  type BranchMeta,
  type BranchStatsResponse,
  branchMetaSchema,
  branchStatsResponseSchema,
  type CreateBranchRequest,
  type CreateBranchResponse,
  createBranchRequestSchema,
  createBranchResponseSchema,
  type DeleteBranchResponse,
  type DocumentBranchesState,
  deleteBranchResponseSchema,
  documentBranchesStateSchema,
  type MergeRequest,
  type MergeResponse,
  mergeRequestSchema,
  mergeResponseSchema,
  type RenameBranchRequest,
  type RenameBranchResponse,
  renameBranchRequestSchema,
  renameBranchResponseSchema,
  type SetHeadRequest,
  type SetHeadResponse,
  setHeadRequestSchema,
  setHeadResponseSchema,
} from './branches.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('branchMetaSchema', () => {
  const valid = {
    name: 'main',
    tipFrontiers: 'abc123',
    color: '#ff0000',
    createdAt: '2024-01-01T00:00:00.000Z',
  }

  it('parses a well-formed value', () => {
    const result: BranchMeta = branchMetaSchema.parse(valid)
    expect(result.name).toBe('main')
  })

  it('roundtrip preserves all fields', () => {
    const withOptionals = { ...valid, baseBranch: 'root', baseVersionId: 'v1' }
    const result: BranchMeta = roundtrip(branchMetaSchema, withOptionals)
    expect(result).toEqual(withOptionals)
  })

  it('rejects missing required fields', () => {
    const { name: _omit, ...missing } = valid
    expect(branchMetaSchema.safeParse(missing).success).toBe(false)
  })
})

describe('documentBranchesStateSchema', () => {
  const valid: DocumentBranchesState = {
    branches: [
      { name: 'main', tipFrontiers: 'abc', color: '#fff', createdAt: '2024-01-01T00:00:00.000Z' },
    ],
    head: 'main',
  }

  it('parses a well-formed value', () => {
    const result: DocumentBranchesState = documentBranchesStateSchema.parse(valid)
    expect(result.head).toBe('main')
  })

  it('roundtrip preserves branches array', () => {
    const result: DocumentBranchesState = roundtrip(documentBranchesStateSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing head', () => {
    const { head: _omit, ...missing } = valid
    expect(documentBranchesStateSchema.safeParse(missing).success).toBe(false)
  })
})

describe('createBranchRequestSchema', () => {
  const valid: CreateBranchRequest = { name: 'feature' }

  it('parses a well-formed value', () => {
    const result: CreateBranchRequest = createBranchRequestSchema.parse(valid)
    expect(result.name).toBe('feature')
  })

  it('roundtrip with optional fields', () => {
    const withOptionals: CreateBranchRequest = {
      name: 'feature',
      fromVersionId: 'v2',
      color: '#aabbcc',
    }
    const result: CreateBranchRequest = roundtrip(createBranchRequestSchema, withOptionals)
    expect(result).toEqual(withOptionals)
  })

  it('rejects empty name', () => {
    expect(createBranchRequestSchema.safeParse({ name: '' }).success).toBe(false)
  })

  it('rejects missing name', () => {
    expect(createBranchRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('createBranchResponseSchema', () => {
  const valid: CreateBranchResponse = {
    branch: {
      name: 'feature',
      tipFrontiers: 'abc',
      color: '#0f0',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  }

  it('parses a well-formed value', () => {
    const result: CreateBranchResponse = createBranchResponseSchema.parse(valid)
    expect(result.branch.name).toBe('feature')
  })

  it('roundtrip preserves all fields', () => {
    const result: CreateBranchResponse = roundtrip(createBranchResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing branch', () => {
    expect(createBranchResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('deleteBranchResponseSchema', () => {
  const valid: DeleteBranchResponse = { ok: true, unmergedCommits: 3 }

  it('parses a well-formed value', () => {
    const result: DeleteBranchResponse = deleteBranchResponseSchema.parse(valid)
    expect(result.ok).toBe(true)
  })

  it('roundtrip preserves fields', () => {
    const result: DeleteBranchResponse = roundtrip(deleteBranchResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects ok: false', () => {
    expect(deleteBranchResponseSchema.safeParse({ ok: false, unmergedCommits: 0 }).success).toBe(
      false,
    )
  })

  it('rejects negative unmergedCommits', () => {
    expect(deleteBranchResponseSchema.safeParse({ ok: true, unmergedCommits: -1 }).success).toBe(
      false,
    )
  })
})

describe('branchStatsResponseSchema', () => {
  const valid: BranchStatsResponse = { unmergedCommits: 5, isHead: false }

  it('parses a well-formed value', () => {
    const result: BranchStatsResponse = branchStatsResponseSchema.parse(valid)
    expect(result.isHead).toBe(false)
  })

  it('roundtrip preserves fields', () => {
    const result: BranchStatsResponse = roundtrip(branchStatsResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing isHead', () => {
    expect(branchStatsResponseSchema.safeParse({ unmergedCommits: 0 }).success).toBe(false)
  })
})

describe('renameBranchRequestSchema', () => {
  const valid: RenameBranchRequest = { name: 'new-name' }

  it('parses a well-formed value', () => {
    const result: RenameBranchRequest = renameBranchRequestSchema.parse(valid)
    expect(result.name).toBe('new-name')
  })

  it('roundtrip preserves fields', () => {
    const result: RenameBranchRequest = roundtrip(renameBranchRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects empty name', () => {
    expect(renameBranchRequestSchema.safeParse({ name: '' }).success).toBe(false)
  })
})

describe('renameBranchResponseSchema', () => {
  const valid: RenameBranchResponse = {
    branch: {
      name: 'new-name',
      tipFrontiers: 'def',
      color: '#00f',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    renamedVersionCount: 2,
  }

  it('parses a well-formed value', () => {
    const result: RenameBranchResponse = renameBranchResponseSchema.parse(valid)
    expect(result.renamedVersionCount).toBe(2)
  })

  it('roundtrip preserves fields', () => {
    const result: RenameBranchResponse = roundtrip(renameBranchResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects negative renamedVersionCount', () => {
    expect(
      renameBranchResponseSchema.safeParse({ ...valid, renamedVersionCount: -1 }).success,
    ).toBe(false)
  })
})

describe('setHeadRequestSchema', () => {
  const valid: SetHeadRequest = { branch: 'main' }

  it('parses a well-formed value', () => {
    const result: SetHeadRequest = setHeadRequestSchema.parse(valid)
    expect(result.branch).toBe('main')
  })

  it('roundtrip preserves fields', () => {
    const result: SetHeadRequest = roundtrip(setHeadRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects empty branch', () => {
    expect(setHeadRequestSchema.safeParse({ branch: '' }).success).toBe(false)
  })
})

describe('setHeadResponseSchema', () => {
  const valid: SetHeadResponse = { head: 'feature', previousHead: 'main' }

  it('parses a well-formed value', () => {
    const result: SetHeadResponse = setHeadResponseSchema.parse(valid)
    expect(result.previousHead).toBe('main')
  })

  it('roundtrip preserves fields', () => {
    const result: SetHeadResponse = roundtrip(setHeadResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing previousHead', () => {
    expect(setHeadResponseSchema.safeParse({ head: 'feature' }).success).toBe(false)
  })
})

describe('mergeRequestSchema', () => {
  const valid: MergeRequest = { into: 'main' }

  it('parses a well-formed value', () => {
    const result: MergeRequest = mergeRequestSchema.parse(valid)
    expect(result.into).toBe('main')
  })

  it('roundtrip with optional dryRun', () => {
    const withDryRun: MergeRequest = { into: 'main', dryRun: true }
    const result: MergeRequest = roundtrip(mergeRequestSchema, withDryRun)
    expect(result).toEqual(withDryRun)
  })

  it('rejects empty into', () => {
    expect(mergeRequestSchema.safeParse({ into: '' }).success).toBe(false)
  })
})

describe('mergeResponseSchema', () => {
  const valid: MergeResponse = { badges: [] }

  it('parses a minimal well-formed value', () => {
    const result: MergeResponse = mergeResponseSchema.parse(valid)
    expect(result.badges).toEqual([])
  })

  it('roundtrip with all optional fields populated', () => {
    const full: MergeResponse = {
      badges: [{ type: 'resurrected', elementId: 'n1' }],
      preview: { elementCount: 10 },
      committed: { elementCount: 8 },
      target: { elementCount: 5 },
      source: { elementCount: 3 },
      previewElements: [{ id: 'el1' }],
      newElementIds: ['el1'],
      changedElementIds: ['el2'],
      conflictElementIds: [],
      preMergeVersionId: 'v99',
      switchedHead: { from: 'feature', to: 'main' },
      deletedSource: 'feature',
    }
    const result: MergeResponse = roundtrip(mergeResponseSchema, full)
    expect(result).toEqual(full)
  })

  it('rejects missing badges', () => {
    expect(mergeResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a badge kind the merge engine cannot produce', () => {
    expect(mergeResponseSchema.safeParse({ badges: [{ type: 'conflict' }] }).success).toBe(false)
  })

  it("carries each badge kind's own fields, as the type the merge engine emits", () => {
    const badges: MergeBadge[] = [
      { type: 'resurrected', elementId: 'n1' },
      { type: 'orphan_ref', elementId: 'e1', missingRef: 'n9' },
      { type: 'field_merge', elementId: 'n2', fields: ['x', 'width'] },
    ]
    const result = roundtrip(mergeResponseSchema, { badges })
    // The annotation is the assertion: a wire badge IS a MergeBadge, so a
    // reader switches on `type` instead of re-deriving the shape by hand.
    const read: MergeBadge[] = result.badges
    expect(read).toEqual(badges)
  })
})
