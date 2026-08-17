import { describe, expect, it } from 'vitest'
import {
  wbDocumentCreateInputSchema,
  wbDocumentCreateOutputSchema,
  wbDocumentDeleteInputSchema,
  wbDocumentDeleteOutputSchema,
  wbDocumentListInputSchema,
  wbDocumentListOutputSchema,
  wbDocumentResolveInputSchema,
  wbDocumentResolveOutputSchema,
} from './document-crud.schemas.js'

const VALID_CANVAS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const VALID_WORKSPACE_ID = 'my-workspace'

describe('wbDocumentCreateInputSchema', () => {
  it('accepts valid input with a single-segment path', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a nested path', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'parent/child',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a single-character segment', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'a',
    })
    expect(result.success).toBe(true)
  })

  it('accepts hyphens in the middle of a segment', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'my-doc-v2',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a leading hyphen', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: '-leading',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a trailing hyphen', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'trailing-',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty path', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects whitespace', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'has space',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a dot, which is what forecloses traversal', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'file.txt',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty workspaceId', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: '',
      kind: 'spatial',
      path: 'doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'doc',
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty parentId', () => {
    const result = wbDocumentCreateInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'doc',
      parentId: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentCreateOutputSchema', () => {
  it('accepts valid output', () => {
    const result = wbDocumentCreateOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid documentId', () => {
    const result = wbDocumentCreateOutputSchema.safeParse({
      documentId: 'not-a-ulid',
      path: 'my-doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentCreateOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
      extra: 1,
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentResolveInputSchema', () => {
  it('accepts valid input', () => {
    const result = wbDocumentResolveInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing documentId', () => {
    const result = wbDocumentResolveInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing workspaceId', () => {
    const result = wbDocumentResolveInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentResolveInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentResolveOutputSchema', () => {
  it('accepts valid canvas detail', () => {
    const result = wbDocumentResolveOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing path', () => {
    const result = wbDocumentResolveOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentResolveOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentListInputSchema', () => {
  it('accepts valid input', () => {
    const result = wbDocumentListInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects workspaceId with slash (path traversal)', () => {
    const result = wbDocumentListInputSchema.safeParse({
      workspaceId: '../parent',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentListInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentListOutputSchema', () => {
  it('accepts empty documents array', () => {
    const result = wbDocumentListOutputSchema.safeParse({
      documents: [],
    })
    expect(result.success).toBe(true)
  })

  it('accepts array with valid canvas details', () => {
    const result = wbDocumentListOutputSchema.safeParse({
      documents: [
        { documentId: VALID_CANVAS_ID, path: 'doc-a' },
        { documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'doc-b' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a canvas detail with no path', () => {
    const result = wbDocumentListOutputSchema.safeParse({
      documents: [{ documentId: VALID_CANVAS_ID }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentListOutputSchema.safeParse({
      documents: [],
      total: 0,
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentDeleteInputSchema', () => {
  it('accepts valid input', () => {
    const result = wbDocumentDeleteInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing workspaceId', () => {
    const result = wbDocumentDeleteInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing documentId', () => {
    const result = wbDocumentDeleteInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentDeleteInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
      force: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('wbDocumentDeleteOutputSchema', () => {
  it('accepts { deleted: true }', () => {
    const result = wbDocumentDeleteOutputSchema.safeParse({ deleted: true })
    expect(result.success).toBe(true)
  })

  it('rejects { deleted: false }', () => {
    const result = wbDocumentDeleteOutputSchema.safeParse({ deleted: false })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = wbDocumentDeleteOutputSchema.safeParse({
      deleted: true,
      id: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })
})
