import { describe, expect, it } from 'vitest'
import { buildFontFaceDescriptors } from './font-registration.js'

describe('buildFontFaceDescriptors', () => {
  it('returns an empty descriptor object when no optional fields are present', () => {
    expect(buildFontFaceDescriptors({})).toEqual({})
  })

  it('includes only the descriptors that are actually present on the font', () => {
    expect(buildFontFaceDescriptors({ weight: '400' })).toEqual({ weight: '400' })
    expect(buildFontFaceDescriptors({ style: 'italic' })).toEqual({ style: 'italic' })
    expect(buildFontFaceDescriptors({ unicodeRange: 'U+20-7e' })).toEqual({
      unicodeRange: 'U+20-7e',
    })
  })

  it('assembles all descriptors together when every optional field is present', () => {
    expect(
      buildFontFaceDescriptors({ weight: '700', style: 'italic', unicodeRange: 'U+20-7e' }),
    ).toEqual({ weight: '700', style: 'italic', unicodeRange: 'U+20-7e' })
  })
})
