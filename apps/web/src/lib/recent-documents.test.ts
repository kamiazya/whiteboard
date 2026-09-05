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

  // A workspace handle is text the user chose: `deriveWorkspaceSegment`
  // lowercases a display name, and `constructor` passes the segment charset,
  // so a workspace named "Constructor" mints exactly that handle. A plain
  // object answers it with an INHERITED value that is truthy, so `?? []`
  // never fires and the lane is handed a Function to map over — measured, it
  // threw on `.map` and took the whole panel down, with storage EMPTY and so
  // no way for the person to clear it.
  //
  // The whole prototype class is covered rather than the one reachable
  // member, since what the segment charset allows is not this module's to
  // know and a widened charset must not reopen this.
  const PROTOTYPE_HANDLES = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']

  for (const handle of PROTOTYPE_HANDLES) {
    it(`answers empty for the unrecorded prototype-named handle ${handle}`, () => {
      expect(readRecentIds(handle)).toEqual([])
    })

    it(`never throws or answers a non-array for the handle ${handle}`, () => {
      expect(() => recordRecentDocument(handle, 'doc-1')).not.toThrow()
      expect(Array.isArray(readRecentIds(handle))).toBe(true)
    })
  }

  // `__proto__` is deliberately absent: zod's `z.record` rebuilds the parsed
  // object by ASSIGNMENT, and assigning `__proto__` sets the prototype rather
  // than defining an own property, so the entry does not survive a round
  // trip. It degrades to an empty lane, which is the guarantee above, and it
  // is unreachable anyway — the segment charset has no underscore. Chasing
  // persistence for it would mean a null-prototype store for a handle nobody
  // can mint.
  for (const handle of PROTOTYPE_HANDLES.filter((each) => each !== '__proto__')) {
    it(`reads back what was recorded under the handle ${handle}`, () => {
      recordRecentDocument(handle, 'doc-1')

      expect(readRecentIds(handle)).toEqual(['doc-1'])
    })
  }

  it('leaves another workspace intact when one is recorded', () => {
    recordRecentDocument('alpha', 'a-doc')
    recordRecentDocument('beta', 'b-doc')
    recordRecentDocument('alpha', 'a-doc-2')

    expect(readRecentIds('beta')).toEqual(['b-doc'])
  })
})
