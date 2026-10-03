import { describe, expect, it } from 'vitest'
import {
  decodeSegment,
  documentPathForAction,
  documentPathForFile,
  parseDocumentApiPath,
} from './document-url.js'

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

describe('parseDocumentApiPath', () => {
  it.each([
    ['an empty tail segment', '/api/w/ws/document/a//snapshot'],
    ['a malformed workspace segment', '/api/w/w%1/document/a/snapshot'],
    ['a malformed tail segment', '/api/w/ws/document/a%zz/snapshot'],
    ['a trailing slash', '/api/w/ws/document/a/snapshot/'],
  ])('answers not-a-route for %s', (_name, path) => {
    expect(parseDocumentApiPath(path)).toBeNull()
  })
})

describe('documentPathForAction', () => {
  it('answers null for an action with no document before it', () => {
    expect(documentPathForAction(['snapshot'], 'snapshot')).toBeNull()
  })

  it('answers null when the final segment is a different action', () => {
    expect(documentPathForAction(['a', 'update'], 'snapshot')).toBeNull()
  })
})

describe('documentPathForFile', () => {
  it('answers null for a tail too short to hold a path, marker and file id', () => {
    expect(documentPathForFile(['file', 'x'])).toBeNull()
  })

  it('answers null when the second-to-last segment is not the file marker', () => {
    expect(documentPathForFile(['a', 'b', 'x'])).toBeNull()
  })

  it('splits a well-formed tail into path and file id', () => {
    expect(documentPathForFile(['a', 'file', 'x'])).toEqual({ path: 'a', fileId: 'x' })
  })
})
