import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSeenDigest, recordSeenDocument, SEEN_CAP, STORAGE_KEY } from './seen-documents.js'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('seen documents (per-device, localStorage)', () => {
  it('reads back the digest a document was recorded with', () => {
    recordSeenDocument('space', 'doc-1', 'digest-a')

    expect(readSeenDigest('space', 'doc-1')).toBe('digest-a')
  })

  it('answers undefined for a document never recorded, which is what makes an unseen card silent', () => {
    expect(readSeenDigest('space', 'never-opened')).toBeUndefined()
  })

  it('keeps the newest digest when a document is recorded again', () => {
    recordSeenDocument('space', 'doc-1', 'digest-a')
    recordSeenDocument('space', 'doc-1', 'digest-b')

    expect(readSeenDigest('space', 'doc-1')).toBe('digest-b')
  })

  it('keeps each workspace independent', () => {
    recordSeenDocument('alpha', 'shared-id', 'digest-a')
    recordSeenDocument('beta', 'shared-id', 'digest-b')

    expect(readSeenDigest('alpha', 'shared-id')).toBe('digest-a')
    expect(readSeenDigest('beta', 'shared-id')).toBe('digest-b')
  })

  it('caps the record rather than growing without bound', () => {
    for (let i = 0; i < SEEN_CAP + 5; i++) recordSeenDocument('space', `doc-${i}`, `digest-${i}`)

    expect(readSeenDigest('space', `doc-${SEEN_CAP + 4}`)).toBe(`digest-${SEEN_CAP + 4}`)
    expect(readSeenDigest('space', 'doc-0')).toBeUndefined()
  })

  it('answers undefined rather than throwing when the payload is not what we wrote', () => {
    localStorage.setItem(STORAGE_KEY, '{"space":"not-a-record"}')

    expect(readSeenDigest('space', 'doc-1')).toBeUndefined()
  })

  it('answers undefined rather than throwing when the payload is not JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not json at all')

    expect(readSeenDigest('space', 'doc-1')).toBeUndefined()
  })

  it('degrades to empty when localStorage itself throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(readSeenDigest('space', 'doc-1')).toBeUndefined()
  })

  it('swallows a write localStorage refuses', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => recordSeenDocument('space', 'doc-1', 'digest-a')).not.toThrow()
  })

  // The same class that crashed the recency lane: a plain object answers some
  // handles with an INHERITED member, and `constructor` is reachable because
  // it passes the workspace segment charset and `deriveWorkspaceSegment`
  // lowercases a display name. Covered on BOTH axes here — the workspace
  // handle and the document id — since either indexes an object.
  for (const poisoned of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    it(`never throws or answers a non-string for the workspace handle ${poisoned}`, () => {
      expect(readSeenDigest(poisoned, 'doc-1')).toBeUndefined()
      expect(() => recordSeenDocument(poisoned, 'doc-1', 'digest-a')).not.toThrow()
      const back = readSeenDigest(poisoned, 'doc-1')
      expect(back === undefined || typeof back === 'string').toBe(true)
    })

    it(`never throws or answers a non-string for the document id ${poisoned}`, () => {
      expect(readSeenDigest('space', poisoned)).toBeUndefined()
      expect(() => recordSeenDocument('space', poisoned, 'digest-a')).not.toThrow()
      const back = readSeenDigest('space', poisoned)
      expect(back === undefined || typeof back === 'string').toBe(true)
    })
  }
})
