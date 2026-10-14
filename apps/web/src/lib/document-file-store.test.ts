// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const openWhiteboardDbMock = vi.hoisted(() => vi.fn())
// Partial: the store names `DOCUMENT_FILES_STORE` from this module too, and a
// mock without it fails BEFORE the open is attempted — which `get`/`read`
// swallow, so a test of the open failure would pass without reaching it.
vi.mock('./browser-idb.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./browser-idb.js')>()),
  openWhiteboardDb: openWhiteboardDbMock,
}))

// The setup file has already loaded `idb-tx.js` (through the workspace-id
// accessor it seeds), bound to the REAL opener; a mock registered afterwards
// reaches only modules evaluated afterwards. Resetting the registry makes the
// store's graph — `idb-tx.js` included — evaluate again against the mock.
vi.resetModules()
const { DocumentFileStore, documentFileRecordSchema } = await import('./document-file-store.js')

afterEach(() => openWhiteboardDbMock.mockReset())

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

describe('DocumentFileStore.read', () => {
  it('answers unreadable instead of rejecting when opening the database fails', async () => {
    const failure = new Error('VersionError: boom')
    openWhiteboardDbMock.mockRejectedValueOnce(failure)
    const store = new DocumentFileStore()

    await expect(store.read('file-1')).resolves.toEqual({ kind: 'unreadable', error: failure })
    expect(openWhiteboardDbMock).toHaveBeenCalledOnce()
  })
})

describe('DocumentFileStore.read', () => {
  it('calls a store it could not open unreadable, not absent', async () => {
    // The bytes may well be there; this device could not reach them, and a
    // caller reporting "missing" would be saying something it does not know.
    const error = new Error('VersionError: boom')
    openWhiteboardDbMock.mockRejectedValueOnce(error)

    expect(await new DocumentFileStore().read('file-1')).toEqual({ kind: 'unreadable', error })
    expect(openWhiteboardDbMock).toHaveBeenCalledOnce()
  })
})
