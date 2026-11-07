import { describe, expect, it } from 'vitest'
import {
  decodeSegment,
  documentByIdApiUrl,
  documentFileByIdApiUrl,
  encodePathSegment,
} from './document-url.js'

// Every URL parser in the apps (the web routes, the daemon's handle parser)
// answers a malformed percent sequence with not-a-match rather than a throw,
// so a hostile address cannot take a render or a request down. They share
// this one decode for that reason.
describe('decodeSegment', () => {
  it('decodes a percent-encoded segment', () => {
    expect(decodeSegment('notes%2F2026%20plan')).toBe('notes/2026 plan')
  })

  it('answers null for a malformed percent sequence instead of throwing', () => {
    expect(decodeSegment('w%1')).toBeNull()
    expect(decodeSegment('%E0%A4%A')).toBeNull()
  })
})

// The URL parser resolves a `.` or `..` segment (and `%2e` spelling either)
// before fetch sends anything, so a URL built from one names a different
// same-origin `/api` path than the one it was built for. No workspace id,
// document id or file id the model admits is a dot segment.
describe('dot segments', () => {
  it.each(['.', '..'])('refuses the segment %j wherever it is placed', (segment) => {
    expect(() => encodePathSegment(segment)).toThrow(/dot segment/)
    expect(() => documentByIdApiUrl(segment, 'doc', 'snapshot')).toThrow(/dot segment/)
    expect(() => documentByIdApiUrl('ws', segment, 'snapshot')).toThrow(/dot segment/)
    expect(() => documentFileByIdApiUrl('ws', 'doc', segment)).toThrow(/dot segment/)
  })

  it('keeps segments that merely contain dots', () => {
    expect(encodePathSegment('...')).toBe('...')
    expect(encodePathSegment('a.b%2e')).toBe('a.b%252e')
  })
})
