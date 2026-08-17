import { describe, expect, it } from 'vitest'
import { versionListInputSchema, versionListOutputSchema } from './version-list.js'
import {
  VersionNotFoundError,
  versionRestoreInputSchema,
  versionRestoreOutputSchema,
} from './version-restore.js'
import { versionSaveInputSchema, versionSaveOutputSchema } from './version-save.js'

const VALID_CANVAS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('versionSaveInputSchema', () => {
  it('accepts valid input', () => {
    const result = versionSaveInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      label: 'Initial draft',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty label', () => {
    const result = versionSaveInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      label: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects label exceeding 200 characters', () => {
    const result = versionSaveInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      label: 'x'.repeat(201),
    })
    expect(result.success).toBe(false)
  })

  it('accepts label at exactly 200 characters', () => {
    const result = versionSaveInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      label: 'x'.repeat(200),
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid documentId', () => {
    const result = versionSaveInputSchema.safeParse({
      documentId: 'not-a-ulid',
      label: 'draft',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = versionSaveInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      label: 'draft',
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('versionSaveOutputSchema', () => {
  it('accepts valid output', () => {
    const result = versionSaveOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      versionId: 'ver-1',
      label: 'Initial draft',
      timestamp: '2026-07-30T00:00:00.000Z',
      frontier: 'abcdef0123',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing frontier', () => {
    const result = versionSaveOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      versionId: 'ver-1',
      label: 'draft',
      timestamp: '2026-07-30T00:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })
})

describe('versionListInputSchema', () => {
  it('accepts valid input', () => {
    const result = versionListInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects extra keys (strict)', () => {
    const result = versionListInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      limit: 10,
    })
    expect(result.success).toBe(false)
  })
})

describe('versionListOutputSchema', () => {
  it('accepts empty versions array', () => {
    const result = versionListOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      versions: [],
    })
    expect(result.success).toBe(true)
  })

  it('accepts versions with valid entries', () => {
    const result = versionListOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      versions: [
        { versionId: 'v1', label: 'first', timestamp: '2026-01-01T00:00:00Z', frontier: 'aa' },
        { versionId: 'v2', label: 'second', timestamp: '2026-01-02T00:00:00Z', frontier: 'bb' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects version entry missing label', () => {
    const result = versionListOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      versions: [{ versionId: 'v1', timestamp: '2026-01-01T00:00:00Z', frontier: 'aa' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('versionRestoreInputSchema', () => {
  it('accepts valid input', () => {
    const result = versionRestoreInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_CANVAS_ID,
      versionId: 'ver-1',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty versionId', () => {
    const result = versionRestoreInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_CANVAS_ID,
      versionId: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing workspaceId', () => {
    const result = versionRestoreInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      versionId: 'ver-1',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = versionRestoreInputSchema.safeParse({
      workspaceId: 'default',
      documentId: VALID_CANVAS_ID,
      versionId: 'ver-1',
      force: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('versionRestoreOutputSchema', () => {
  it('accepts valid output', () => {
    const result = versionRestoreOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      restoredVersionId: 'ver-1',
      label: 'Initial draft',
      frontier: 'abcdef0123',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing restoredVersionId', () => {
    const result = versionRestoreOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      label: 'draft',
      frontier: 'aa',
    })
    expect(result.success).toBe(false)
  })
})

describe('VersionNotFoundError', () => {
  it('carries documentId and versionId', () => {
    const err = new VersionNotFoundError(VALID_CANVAS_ID, 'ver-99')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('VersionNotFoundError')
    expect(err.documentId).toBe(VALID_CANVAS_ID)
    expect(err.versionId).toBe('ver-99')
    expect(err.message).toContain('ver-99')
  })
})
