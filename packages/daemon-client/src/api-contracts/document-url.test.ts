import { describe, expect, it } from 'vitest'
import { decodeSegment } from './document-url.js'

// Every URL parser in the apps (web routes, the daemon's document routes, this
// package's API-path parser) answers a malformed percent sequence with
// not-a-match rather than a throw, so a hostile address cannot take a render or
// a request down. They share this one decode for that reason.
describe('decodeSegment', () => {
  it('decodes a percent-encoded segment', () => {
    expect(decodeSegment('notes%2F2026%20plan')).toBe('notes/2026 plan')
  })

  it('answers null for a malformed percent sequence instead of throwing', () => {
    expect(decodeSegment('w%1')).toBeNull()
    expect(decodeSegment('%E0%A4%A')).toBeNull()
  })
})
