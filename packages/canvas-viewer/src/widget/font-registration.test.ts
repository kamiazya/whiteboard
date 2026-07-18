import { describe, expect, it } from 'vitest'
import { buildFontFaceDescriptors, resolveFontFetchDataUri } from './font-registration.js'

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

describe('resolveFontFetchDataUri', () => {
  const filenameMap = { 'Excalifont-Regular-abc.woff2': 'data:font/woff2;base64,AAAA' }

  it('resolves a plain string URL input against the filename map', () => {
    expect(
      resolveFontFetchDataUri(
        'https://cdn.example.com/fonts/Excalifont-Regular-abc.woff2',
        filenameMap,
      ),
    ).toBe('data:font/woff2;base64,AAAA')
  })

  it('resolves a URL carrying query parameters or a hash fragment', () => {
    const map = { 'Excalifont.woff2': 'data:font/woff2;base64,AAAA' }
    expect(resolveFontFetchDataUri('https://x/fonts/Excalifont.woff2?v=2', map)).toBe(
      'data:font/woff2;base64,AAAA',
    )
    expect(resolveFontFetchDataUri('https://x/fonts/Excalifont.woff2#frag', map)).toBe(
      'data:font/woff2;base64,AAAA',
    )
  })

  it('resolves a URL instance input against the filename map', () => {
    expect(
      resolveFontFetchDataUri(
        new URL('https://cdn.example.com/fonts/Excalifont-Regular-abc.woff2'),
        filenameMap,
      ),
    ).toBe('data:font/woff2;base64,AAAA')
  })

  it('resolves a Request instance input via its .url property', () => {
    const request = new Request('https://cdn.example.com/fonts/Excalifont-Regular-abc.woff2')
    expect(resolveFontFetchDataUri(request, filenameMap)).toBe('data:font/woff2;base64,AAAA')
  })

  it('returns undefined for a filename this build did not embed', () => {
    expect(
      resolveFontFetchDataUri('https://cdn.example.com/fonts/OtherFont-Regular.woff2', filenameMap),
    ).toBeUndefined()
  })
})
