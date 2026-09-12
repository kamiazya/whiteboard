import { describe, expect, it } from 'vitest'
import { versionEntryForAgent } from '../versions/version-entry.js'
import { versionListInputSchema, versionListOutputSchema } from './version-list.js'
import {
  VersionNotFoundError,
  versionRestoreInputSchema,
  versionRestoreOutputSchema,
} from './version-restore.js'
import { versionSaveInputSchema, versionSaveOutputSchema } from './version-save.js'

const VALID_DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const VALID_ENTRY = {
  id: 'ver-1',
  path: 'notes/plan',
  createdAt: '2026-07-30T00:00:00.000Z',
  elementCount: 3,
  label: 'Initial draft',
  auto: false,
  branchName: 'main',
}

describe('versionSaveInputSchema', () => {
  it('accepts valid input', () => {
    const result = versionSaveInputSchema.safeParse({
      workspaceId: 'default',
      documentIds: [VALID_DOCUMENT_ID],
      label: 'Initial draft',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty label', () => {
    const result = versionSaveInputSchema.safeParse({
      workspaceId: 'default',
      documentIds: [VALID_DOCUMENT_ID],
      label: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects label exceeding 200 characters', () => {
    const result = versionSaveInputSchema.safeParse({
      workspaceId: 'default',
      documentIds: [VALID_DOCUMENT_ID],
      label: 'x'.repeat(201),
    })
    expect(result.success).toBe(false)
  })

  it('accepts label at exactly 200 characters', () => {
    const result = versionSaveInputSchema.safeParse({
      workspaceId: 'default',
      documentIds: [VALID_DOCUMENT_ID],
      label: 'x'.repeat(200),
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid documentId', () => {
    const result = versionSaveInputSchema.safeParse({
      workspaceId: 'default',
      documentIds: ['not-a-ulid'],
      label: 'draft',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = versionSaveInputSchema.safeParse({
      workspaceId: 'default',
      documentIds: [VALID_DOCUMENT_ID],
      label: 'draft',
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('versionSaveOutputSchema', () => {
  it('answers the version as an agent reads it, not as the History panel does', () => {
    const result = versionSaveOutputSchema.safeParse({
      saved: [{ documentId: VALID_DOCUMENT_ID, version: versionEntryForAgent(VALID_ENTRY) }],
    })
    expect(result.success).toBe(true)
  })

  it('refuses the panel row whole: path, counts and the retired branch column are not for an agent', () => {
    const result = versionSaveOutputSchema.safeParse({
      saved: [{ documentId: VALID_DOCUMENT_ID, version: VALID_ENTRY }],
    })
    expect(result.success).toBe(false)
  })

  it('keeps who saved it, and drops the ids a person never types', () => {
    expect(
      versionEntryForAgent({
        ...VALID_ENTRY,
        operator: { kind: 'ai', actor: 'process:p1', agentId: 'a1', displayName: 'Claude' },
      }),
    ).toEqual({
      id: 'ver-1',
      createdAt: '2026-07-30T00:00:00.000Z',
      label: 'Initial draft',
      auto: false,
      operator: { kind: 'ai', displayName: 'Claude' },
    })
  })
})

describe('versionListInputSchema', () => {
  it('accepts valid input', () => {
    const result = versionListInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_DOCUMENT_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects extra keys (strict)', () => {
    const result = versionListInputSchema.safeParse({
      documentId: VALID_DOCUMENT_ID,
      limit: 10,
    })
    expect(result.success).toBe(false)
  })
})

describe('versionListOutputSchema', () => {
  it('accepts empty versions array', () => {
    const result = versionListOutputSchema.safeParse({
      documentId: VALID_DOCUMENT_ID,
      versions: [],
    })
    expect(result.success).toBe(true)
  })

  it('accepts versions with valid entries, label being optional (an auto checkpoint has none)', () => {
    const { label: _dropped, ...unlabelled } = VALID_ENTRY
    const result = versionListOutputSchema.safeParse({
      documentId: VALID_DOCUMENT_ID,
      versions: [
        versionEntryForAgent(VALID_ENTRY),
        versionEntryForAgent({ ...unlabelled, id: 'v2', auto: true }),
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a version entry missing its id', () => {
    const { id: _dropped, ...noId } = versionEntryForAgent(VALID_ENTRY)
    const result = versionListOutputSchema.safeParse({
      documentId: VALID_DOCUMENT_ID,
      versions: [noId],
    })
    expect(result.success).toBe(false)
  })
})

describe('versionRestoreInputSchema', () => {
  it('accepts valid input', () => {
    const result = versionRestoreInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_DOCUMENT_ID,
      versionId: 'ver-1',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty versionId', () => {
    const result = versionRestoreInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_DOCUMENT_ID,
      versionId: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing workspaceId', () => {
    const result = versionRestoreInputSchema.safeParse({
      documentId: VALID_DOCUMENT_ID,
      versionId: 'ver-1',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = versionRestoreInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_DOCUMENT_ID,
      versionId: 'ver-1',
      force: true,
    })
    expect(result.success).toBe(false)
  })

  it('accepts targetPath, overwrite and subtree, and rejects a malformed targetPath', () => {
    const base = { workspaceId: 'default', documentId: VALID_DOCUMENT_ID, versionId: 'ver-1' }
    expect(
      versionRestoreInputSchema.safeParse({ ...base, targetPath: 'notes/copy', overwrite: true })
        .success,
    ).toBe(true)
    expect(versionRestoreInputSchema.safeParse({ ...base, subtree: true }).success).toBe(true)
    expect(versionRestoreInputSchema.safeParse({ ...base, targetPath: '../escape' }).success).toBe(
      false,
    )
  })
})

describe('versionRestoreOutputSchema', () => {
  it('accepts each mode, with and without a label', () => {
    const base = { documentId: VALID_DOCUMENT_ID, restoredVersionId: 'ver-1' }
    expect(
      versionRestoreOutputSchema.safeParse({ ...base, label: 'Initial draft', mode: 'in-place' })
        .success,
    ).toBe(true)
    expect(versionRestoreOutputSchema.safeParse({ ...base, mode: 'in-place' }).success).toBe(true)
    expect(
      versionRestoreOutputSchema.safeParse({
        ...base,
        mode: 'into-target',
        targetPath: 'notes/copy',
        elementCount: 3,
      }).success,
    ).toBe(true)
    expect(
      versionRestoreOutputSchema.safeParse({ ...base, mode: 'subtree', restoredCount: 2 }).success,
    ).toBe(true)
  })

  it('rejects a missing mode and a missing restoredVersionId', () => {
    expect(
      versionRestoreOutputSchema.safeParse({
        documentId: VALID_DOCUMENT_ID,
        restoredVersionId: 'ver-1',
      }).success,
    ).toBe(false)
    expect(
      versionRestoreOutputSchema.safeParse({
        documentId: VALID_DOCUMENT_ID,
        label: 'draft',
        mode: 'in-place',
      }).success,
    ).toBe(false)
  })
})

describe('VersionNotFoundError', () => {
  it('carries documentId and versionId', () => {
    const err = new VersionNotFoundError(VALID_DOCUMENT_ID, 'ver-99')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('VersionNotFoundError')
    expect(err.documentId).toBe(VALID_DOCUMENT_ID)
    expect(err.versionId).toBe('ver-99')
    expect(err.message).toContain('ver-99')
  })
})
