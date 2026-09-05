// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const openWhiteboardDbMock = vi.hoisted(() => vi.fn())
vi.mock('./browser-idb.js', () => ({ openWhiteboardDb: openWhiteboardDbMock }))

const { DocumentFileStore, documentFileRecordSchema, dataUrlToBlob } = await import(
  './document-file-store.js'
)

describe('dataUrlToBlob', () => {
  it('decodes a valid PNG dataURL into a Blob with the correct mimeType and byte length', async () => {
    // 1x1 transparent PNG.
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const dataURL = `data:image/png;base64,${base64}`

    const blob = dataUrlToBlob(dataURL, 'image/png')

    expect(blob.type).toBe('image/png')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes.length).toBe(atob(base64).length)
  })

  it('prefers the dataURL prefix mimeType and falls back to the provided field when the prefix is absent/malformed', () => {
    const validDataUrl = 'data:image/jpeg;base64,QQ=='
    expect(dataUrlToBlob(validDataUrl, 'image/png').type).toBe('image/jpeg')

    // Malformed prefix (missing the `data:` scheme) — fall back to the field.
    const noPrefixDataUrl = 'base64,QQ=='
    expect(dataUrlToBlob(noPrefixDataUrl, 'image/png').type).toBe('image/png')
  })

  it('rejects a malformed dataURL (no comma) rather than producing an empty Blob', () => {
    expect(() => dataUrlToBlob('not-a-data-url', 'image/png')).toThrow()
  })

  it('rejects a dataURL with invalid base64 payload', () => {
    expect(() => dataUrlToBlob('data:image/png;base64,not valid base64!!!', 'image/png')).toThrow()
  })
})

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
