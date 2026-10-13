import { isUploadableImageType } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'

/**
 * A stored picture's own bytes as a `data:` URL, or `undefined` when it is
 * larger than `maxBytes` or of a type no keeper stores.
 *
 * The bytes as stored, never re-encoded: unlike an export, which holds only
 * the page's `blob:` URL and has to decode it to reach the pixels, a caller
 * here has the blob, and its original encoding is the smallest one there is.
 * A `data:` URL rather than a `blob:` one because the picture it goes into
 * is remembered past the tab (ADR-0027 decision 5), where a `blob:` URL
 * names nothing.
 *
 * Encoded by `FileReader` rather than by hand. Measured in Chromium per
 * 256 KiB: base64 in script held this thread 8.3 ms; the reader answered in
 * 1.9 ms and never held it longer than 0.4 ms.
 */
export async function imageDataUrl(blob: Blob, maxBytes: number): Promise<string | undefined> {
  if (blob.size > maxBytes || !isUploadableImageType(blob.type)) return undefined
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const { result } = reader
      if (typeof result === 'string') resolve(result)
      else reject(new Error('the reader answered something that is not a data: URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('the picture could not be read'))
    reader.readAsDataURL(blob)
  })
}
