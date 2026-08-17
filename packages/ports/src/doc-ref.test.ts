import { describe, expect, it } from 'vitest'
import { docRefSchema } from './doc-ref.js'

describe('docRefSchema', () => {
  it('accepts a canvas doc ref', () => {
    const result = docRefSchema.safeParse({
      kind: 'canvas',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a workspace-tree doc ref', () => {
    const result = docRefSchema.safeParse({ kind: 'workspace-tree', workspaceId: 'workspace-a' })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect(docRefSchema.safeParse({ kind: 'blob', id: 'x' }).success).toBe(false)
  })

  it('rejects a canvas ref missing documentId', () => {
    expect(docRefSchema.safeParse({ kind: 'canvas' }).success).toBe(false)
  })

  it('rejects a canvas ref whose documentId is not a ULID', () => {
    expect(docRefSchema.safeParse({ kind: 'canvas', documentId: 'workspace-a' }).success).toBe(
      false,
    )
  })

  it('rejects a workspace-tree ref whose workspaceId is a ULID-shaped value with a slash', () => {
    expect(docRefSchema.safeParse({ kind: 'workspace-tree', workspaceId: 'a/b' }).success).toBe(
      false,
    )
  })

  it('rejects an extra unknown key (strict)', () => {
    expect(
      docRefSchema.safeParse({ kind: 'canvas', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', extra: 1 })
        .success,
    ).toBe(false)
  })
})
