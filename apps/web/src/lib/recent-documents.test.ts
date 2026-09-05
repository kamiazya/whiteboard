import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECENT_CAP, readRecentIds, recordRecentDocument, STORAGE_KEY } from './recent-documents.js'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('recent documents (per-device, localStorage)', () => {
  it('reads back what was recorded, most recent first', () => {
    recordRecentDocument('space', 'one')
    recordRecentDocument('space', 'two')

    expect(readRecentIds('space')).toEqual(['two', 'one'])
  })

  it('keeps each workspace handle independent', () => {
    recordRecentDocument('alpha', 'a-doc')
    recordRecentDocument('beta', 'b-doc')

    expect(readRecentIds('alpha')).toEqual(['a-doc'])
    expect(readRecentIds('beta')).toEqual(['b-doc'])
  })

  it('caps the stored list rather than growing without bound', () => {
    for (let i = 0; i < RECENT_CAP + 5; i++) recordRecentDocument('space', `doc-${i}`)

    expect(readRecentIds('space')).toHaveLength(RECENT_CAP)
    // The oldest fell off, the newest is at the head.
    expect(readRecentIds('space')[0]).toBe(`doc-${RECENT_CAP + 4}`)
    expect(readRecentIds('space')).not.toContain('doc-0')
  })

  it('answers empty for a workspace that has recorded nothing', () => {
    expect(readRecentIds('never-visited')).toEqual([])
  })

  it('answers empty rather than throwing when the stored payload is not what we wrote', () => {
    // Another tab, an older build, or a person with devtools open. The
    // contract is that the picker still renders.
    localStorage.setItem(STORAGE_KEY, '{"space":"not-a-list"}')

    expect(readRecentIds('space')).toEqual([])
  })

  it('answers empty rather than throwing when the stored payload is not JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not json at all')

    expect(readRecentIds('space')).toEqual([])
  })

  it('degrades to empty when localStorage itself throws', () => {
    // A browser configured to block storage raises SecurityError on ACCESS,
    // not on parse — so a try/catch around JSON.parse alone would not hold.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(readRecentIds('space')).toEqual([])
  })

  it('swallows a write that localStorage refuses', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => recordRecentDocument('space', 'one')).not.toThrow()
  })

  it('leaves another workspace intact when one is recorded', () => {
    recordRecentDocument('alpha', 'a-doc')
    recordRecentDocument('beta', 'b-doc')
    recordRecentDocument('alpha', 'a-doc-2')

    expect(readRecentIds('beta')).toEqual(['b-doc'])
  })
})
