// @vitest-environment node
import {
  MAX_FILE_UPLOAD_BYTES,
  UPLOADABLE_IMAGE_TYPES,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import { describe, expect, it } from 'vitest'
import {
  firstImageFile,
  IMAGE_FILE_ACCEPT,
  imageRefusal,
  uploadRefusalReason,
} from './image-upload-policy.js'

const file = (type: string) => new File([new Uint8Array(4)], 'x', { type })

/** A File whose reported size is `size`, without allocating it. */
function sized(type: string, size: number): File {
  return Object.defineProperty(file(type), 'size', { value: size })
}

describe('what the editor offers to upload', () => {
  it('is the contract the daemon route answers, not a wildcard', () => {
    expect(IMAGE_FILE_ACCEPT.split(',')).toEqual([...UPLOADABLE_IMAGE_TYPES])
    expect(IMAGE_FILE_ACCEPT).not.toContain('*')
  })

  it.each(UPLOADABLE_IMAGE_TYPES)('accepts %s', (type) => {
    expect(imageRefusal(file(type))).toBeNull()
  })

  it('refuses an image type the daemon would answer 415, naming the supported set', () => {
    const message = imageRefusal(file('image/avif'))
    expect(message).toContain('image/avif')
    for (const label of ['PNG', 'JPEG', 'GIF', 'WebP', 'SVG']) expect(message).toContain(label)
  })

  it('refuses a file over the ceiling, naming the limit, and accepts one exactly at it', () => {
    expect(imageRefusal(sized('image/png', MAX_FILE_UPLOAD_BYTES))).toBeNull()
    expect(imageRefusal(sized('image/png', MAX_FILE_UPLOAD_BYTES + 1))).toContain('16 MiB')
  })
})

describe('firstImageFile', () => {
  it('prefers a supported image over an earlier unsupported one', () => {
    const avif = file('image/avif')
    const png = file('image/png')
    expect(firstImageFile([avif, png])).toBe(png)
  })

  it('returns an unsupported image when it is the only one, so it can be refused aloud', () => {
    const avif = file('image/avif')
    expect(firstImageFile([file('text/plain'), avif])).toBe(avif)
  })

  it('returns undefined when nothing is an image', () => {
    expect(firstImageFile([file('text/plain'), file('')])).toBeUndefined()
  })
})

describe('uploadRefusalReason', () => {
  it('explains a 413 by the limit and a 415 by the supported set', () => {
    expect(uploadRefusalReason(413)).toContain('16 MiB')
    expect(uploadRefusalReason(415)).toContain('PNG')
  })

  it('names the status for any other refusal rather than guessing a cause', () => {
    expect(uploadRefusalReason(500)).toContain('500')
  })
})
