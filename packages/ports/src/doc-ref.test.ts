import { describe, expect, it } from 'vitest'
import { docRefSchema } from './doc-ref.js'
import { docRefKey } from './doc-ref-key.js'

describe('docRefSchema', () => {
  it('accepts a document ref carrying its workspace', () => {
    const result = docRefSchema.safeParse({
      kind: 'document',
      workspaceId: 'workspace-a',
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

  // The workspace is part of the contract (dual-plane collapse W3): a
  // consumer holding a document ref must be able to answer "which
  // workspace record projects this document" without a reverse index.
  it('rejects a document ref missing workspaceId', () => {
    expect(
      docRefSchema.safeParse({ kind: 'document', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
        .success,
    ).toBe(false)
  })

  it('rejects a document ref missing documentId', () => {
    expect(docRefSchema.safeParse({ kind: 'document', workspaceId: 'workspace-a' }).success).toBe(
      false,
    )
  })

  it('rejects a document ref whose documentId is not a ULID', () => {
    expect(
      docRefSchema.safeParse({
        kind: 'document',
        workspaceId: 'workspace-a',
        documentId: 'workspace-a',
      }).success,
    ).toBe(false)
  })

  it('rejects a workspace-tree ref whose workspaceId is a ULID-shaped value with a slash', () => {
    expect(docRefSchema.safeParse({ kind: 'workspace-tree', workspaceId: 'a/b' }).success).toBe(
      false,
    )
  })

  it('rejects an extra unknown key (strict)', () => {
    expect(
      docRefSchema.safeParse({
        kind: 'document',
        workspaceId: 'workspace-a',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        extra: 1,
      }).success,
    ).toBe(false)
  })
})

describe('docRefKey', () => {
  // The STORED key deliberately does NOT gain the workspaceId the ref now
  // carries: a documentId is a ULID and already globally unique, and the
  // boot fold must keep reading and sweeping legacy per-document rows
  // written under exactly this key on any not-yet-folded database. Changing
  // it would strand those rows behind an unreachable key.
  it('keys a document ref by documentId alone', () => {
    expect(
      docRefKey({
        kind: 'document',
        workspaceId: 'workspace-a',
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    ).toBe('document:01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('keys a workspace-tree ref by workspaceId', () => {
    expect(docRefKey({ kind: 'workspace-tree', workspaceId: 'workspace-a' })).toBe(
      'workspace-tree:workspace-a',
    )
  })
})
