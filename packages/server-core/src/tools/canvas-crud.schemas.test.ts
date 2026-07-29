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
  it('accepts valid input with segment only', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid input with optional parentId', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'child',
      parentId: 'some-tree-node-id',
    })
    expect(result.success).toBe(true)
  })

  it('accepts single-character segment', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'a',
    })
    expect(result.success).toBe(true)
  })

  it('accepts segment with hyphens and underscores in the middle', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'my-doc_v2',
    })
    expect(result.success).toBe(true)
  })

  it('rejects segment with leading hyphen', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: '-leading',
    })
    expect(result.success).toBe(false)
  })

  it('rejects segment with trailing hyphen', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'trailing-',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty segment', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects segment with spaces', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'has space',
    })
    expect(result.success).toBe(false)
  })

  it('rejects segment with dots', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'file.txt',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty workspaceId', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: '',
      segment: 'doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'doc',
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty parentId', () => {
    const result = createCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      segment: 'doc',
      parentId: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('createCanvasOutputSchema', () => {
  it('accepts valid output', () => {
    const result = createCanvasOutputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
      segment: 'my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid canvasId', () => {
    const result = createCanvasOutputSchema.safeParse({
      canvasId: 'not-a-ulid',
      segment: 'my-doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = createCanvasOutputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
      segment: 'my-doc',
      extra: 1,
    })
    expect(result.success).toBe(false)
  })
})

describe('getCanvasInputSchema', () => {
  it('accepts valid input', () => {
    const result = getCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      canvasId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing canvasId', () => {
    const result = getCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing workspaceId', () => {
    const result = getCanvasInputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = getCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      canvasId: VALID_CANVAS_ID,
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('getCanvasOutputSchema', () => {
  it('accepts valid canvas detail', () => {
    const result = getCanvasOutputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
      segment: 'my-doc',
      alias: '/w/ws/c/my-doc',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing alias', () => {
    const result = getCanvasOutputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
      segment: 'my-doc',
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = getCanvasOutputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
      segment: 'my-doc',
      alias: '/w/ws/c/my-doc',
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
        { canvasId: VALID_CANVAS_ID, segment: 'doc-a', alias: '/c/doc-a' },
        { canvasId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', segment: 'doc-b', alias: '/c/doc-b' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects canvas detail with missing segment', () => {
    const result = listCanvasesOutputSchema.safeParse({
      canvases: [{ canvasId: VALID_CANVAS_ID, alias: '/c/doc' }],
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
      canvasId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing workspaceId', () => {
    const result = deleteCanvasInputSchema.safeParse({
      canvasId: VALID_CANVAS_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing canvasId', () => {
    const result = deleteCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra keys (strict)', () => {
    const result = deleteCanvasInputSchema.safeParse({
      workspaceId: VALID_WORKSPACE_ID,
      canvasId: VALID_CANVAS_ID,
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
