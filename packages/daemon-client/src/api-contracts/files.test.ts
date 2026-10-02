import { describe, expect, it } from 'vitest'
import {
  isUploadableImageType,
  MAX_FILE_UPLOAD_BYTES,
  UPLOADABLE_IMAGE_TYPES,
  uploadableImageTypeSchema,
} from './files.js'

describe('the uploadable image contract', () => {
  it('admits exactly its declared types and nothing a wildcard would', () => {
    for (const type of UPLOADABLE_IMAGE_TYPES) {
      expect(isUploadableImageType(type)).toBe(true)
      expect(uploadableImageTypeSchema.safeParse(type).success).toBe(true)
    }
    for (const type of ['image/avif', 'image/bmp', 'image/*', 'text/plain', '']) {
      expect(isUploadableImageType(type)).toBe(false)
    }
  })

  it('sets a positive whole-byte ceiling', () => {
    expect(Number.isInteger(MAX_FILE_UPLOAD_BYTES)).toBe(true)
    expect(MAX_FILE_UPLOAD_BYTES).toBeGreaterThan(0)
  })
})
