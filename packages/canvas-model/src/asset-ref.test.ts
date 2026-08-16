import { describe, expect, it } from 'vitest'
import { imageRefId, isImageRef, newImageRef } from './asset-ref.js'

describe('isImageRef', () => {
  it('accepts a value carrying the asset: prefix', () => {
    expect(isImageRef('asset:abc123')).toBe(true)
  })

  it('rejects a plain canvas-path/id value with no prefix', () => {
    expect(isImageRef('some-canvas')).toBe(false)
  })
})

describe('newImageRef / imageRefId round-trip', () => {
  it('imageRefId(newImageRef(x)) === x for an arbitrary backend id', () => {
    expect(imageRefId(newImageRef('01ARZ3NDEKTSV4RRFFQ69G5FAV'))).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('newImageRef prefixes with asset:', () => {
    expect(newImageRef('x')).toBe('asset:x')
  })
})
