/**
 * A picture's bytes as a `data:` URL. The reader is the platform's, so the
 * cases below stub it only to reach the answers a real one gives rarely: a
 * failure with no `error` attached, and a result that is not a string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageDataUrl } from './image-data-url.js'

const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

interface StubReader {
  result: unknown
  error: unknown
  onload: (() => void) | null
  onerror: (() => void) | null
}

/** A FileReader that settles as told, the moment it is asked to read. */
function stubReader(settle: (reader: StubReader) => void) {
  vi.stubGlobal(
    'FileReader',
    class implements StubReader {
      result: unknown = null
      error: unknown = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL() {
        queueMicrotask(() => settle(this))
      }
    },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('imageDataUrl', () => {
  it('answers the bytes as stored, as a data: URL of their own type', async () => {
    await expect(imageDataUrl(PNG, 1024)).resolves.toBe('data:image/png;base64,iVBORw==')
  })

  it('answers nothing for a picture over the bound', async () => {
    await expect(imageDataUrl(PNG, 3)).resolves.toBeUndefined()
  })

  it('rejects with an Error when the reader fails without saying why', async () => {
    stubReader((reader) => reader.onerror?.())
    await expect(imageDataUrl(PNG, 1024)).rejects.toBeInstanceOf(Error)
  })

  it('rejects rather than stringifying a result that is not a URL', async () => {
    stubReader((reader) => {
      reader.result = new ArrayBuffer(4)
      reader.onload?.()
    })
    await expect(imageDataUrl(PNG, 1024)).rejects.toThrow('not a data: URL')
  })
})
