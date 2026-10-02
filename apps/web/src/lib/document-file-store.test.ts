// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const openWhiteboardDbMock = vi.hoisted(() => vi.fn())
vi.mock('./browser-idb.js', () => ({ openWhiteboardDb: openWhiteboardDbMock }))

const { DocumentFileStore, documentFileRecordSchema } = await import('./document-file-store.js')

describe('documentFileRecordSchema', () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

  it('accepts a valid v:1 record', () => {
    const result = documentFileRecordSchema.safeParse({
      v: 1,
      mimeType: 'image/png',
      created: 123,
      blob,
    })
    expect(result.success).toBe(true)
  })

  it('rejects records missing mimeType/blob/created', () => {
    expect(documentFileRecordSchema.safeParse({ v: 1, created: 123, blob }).success).toBe(false)
    expect(documentFileRecordSchema.safeParse({ v: 1, mimeType: 'image/png', blob }).success).toBe(
      false,
    )
    expect(
      documentFileRecordSchema.safeParse({ v: 1, mimeType: 'image/png', created: 123 }).success,
    ).toBe(false)
  })

  it('rejects records with a wrong/absent v field', () => {
    expect(
      documentFileRecordSchema.safeParse({ mimeType: 'image/png', created: 123, blob }).success,
    ).toBe(false)
    expect(
      documentFileRecordSchema.safeParse({ v: 2, mimeType: 'image/png', created: 123, blob })
        .success,
    ).toBe(false)
  })
})

describe('DocumentFileStore.get', () => {
  it('resolves null instead of rejecting when opening the database fails', async () => {
    openWhiteboardDbMock.mockRejectedValueOnce(new Error('VersionError: boom'))
    const store = new DocumentFileStore()

    await expect(store.get('file-1')).resolves.toBeNull()
  })
})
