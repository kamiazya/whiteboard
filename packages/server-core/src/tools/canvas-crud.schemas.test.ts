import { describe, expect, it } from 'vitest'
import {
  createCanvasInputSchema,
  createCanvasOutputSchema,
  deleteCanvasInputSchema,
  deleteCanvasOutputSchema,
  getCanvasInputSchema,
  getCanvasOutputSchema,
  listCanvasesInputSchema,
  listCanvasesOutputSchema,
} from './canvas-crud.schemas.js'

const VALID_CANVAS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const VALID_WORKSPACE_ID = 'my-workspace'

describe('createCanvasInputSchema', () => {
  it('accepts valid input with a single-segment path', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a nested path', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'parent/child',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a single-character segment', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'a',
    })
    expect(result.success).toBe(true)
  })

  it('accepts hyphens in the middle of a segment', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'my-doc-v2',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a leading hyphen', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: '-leading',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a trailing hyphen', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'trailing-',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty path', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects whitespace', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'has space',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a dot, which is what forecloses traversal', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'file.txt',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty workspaceId', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: '',
      kind: 'spatial',
      path: 'doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'doc',
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty parentId', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      kind: 'spatial',
      path: 'doc',
      parentId: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('createCanvasOutputSchema', () => {
  it('accepts valid output', () => {
    const result = createCanvasOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid documentId', () => {
    const result = createCanvasOutputSchema.safeParse({
      documentId: 'not-a-ulid',
      path: 'my-doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = createCanvasOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
      extra: 1,
    })
    expect(result.success).toBe(false)
  })
})

describe('getCanvasInputSchema', () => {
  it('accepts valid input', () => {
    const result = getCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing documentId', () => {
    const result = getCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing workspaceId', () => {
    const result = getCanvasInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = getCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('getCanvasOutputSchema', () => {
  it('accepts valid canvas detail', () => {
    const result = getCanvasOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing path', () => {
    const result = getCanvasOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = getCanvasOutputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
      path: 'my-doc',
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('listCanvasesInputSchema', () => {
  it('accepts valid input', () => {
    const result = listCanvasesInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects workspaceId with slash (path traversal)', () => {
    const result = listCanvasesInputSchema.safeParse({
      workspaceId: '../parent',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = listCanvasesInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('listCanvasesOutputSchema', () => {
  it('accepts empty canvases array', () => {
    const result = listCanvasesOutputSchema.safeParse({
      canvases: [],
    })
    expect(result.success).toBe(true)
  })

  it('accepts array with valid canvas details', () => {
    const result = listCanvasesOutputSchema.safeParse({
      canvases: [
        { documentId: VALID_CANVAS_ID, path: 'doc-a' },
        { documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'doc-b' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a canvas detail with no path', () => {
    const result = listCanvasesOutputSchema.safeParse({
      canvases: [{ documentId: VALID_CANVAS_ID }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = listCanvasesOutputSchema.safeParse({
      canvases: [],
      total: 0,
    })
    expect(result.success).toBe(false)
  })
})

describe('deleteCanvasInputSchema', () => {
  it('accepts valid input', () => {
    const result = deleteCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing workspaceId', () => {
    const result = deleteCanvasInputSchema.safeParse({
      documentId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing documentId', () => {
    const result = deleteCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = deleteCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      documentId: VALID_CANVAS_ID,
      force: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('deleteCanvasOutputSchema', () => {
  it('accepts { deleted: true }', () => {
    const result = deleteCanvasOutputSchema.safeParse({ deleted: true })
    expect(result.success).toBe(true)
  })

  it('rejects { deleted: false }', () => {
    const result = deleteCanvasOutputSchema.safeParse({ deleted: false })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = deleteCanvasOutputSchema.safeParse({
      deleted: true,
      id: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })
})
