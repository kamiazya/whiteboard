// @vitest-environment node
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { RECENT_CAP, recordRecentId } from './recent-documents.js'

// The pure half only — no storage, so this runs in node. The localStorage
// contract is `recent-documents.test.ts`.
const PROPERTY_PARAMS = withDefaults({ numRuns: 200 })

// Ids are opaque to the module, so a dense small alphabet is what actually
// exercises dedupe and the cap; `fc.string()` would draw distinct ids almost
// every time and the interesting branch would never run.
const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k')
const idsArb = fc.array(idArb)

describe('recordRecentId (fast-check)', () => {
  fcTest.prop([idsArb, idArb], PROPERTY_PARAMS)(
    'puts the recorded id at the head',
    (existing, id) => {
      expect(recordRecentId(existing, id)[0]).toBe(id)
    },
  )

  fcTest.prop([idsArb, idArb], PROPERTY_PARAMS)(
    'is idempotent: recording the same id twice leaves the same list',
    (existing, id) => {
      const once = recordRecentId(existing, id)
      expect(recordRecentId(once, id)).toEqual(once)
    },
  )

  fcTest.prop([idsArb, idArb], PROPERTY_PARAMS)('never exceeds the cap', (existing, id) => {
    expect(recordRecentId(existing, id).length).toBeLessThanOrEqual(RECENT_CAP)
  })

  fcTest.prop([idsArb, idArb], PROPERTY_PARAMS)('holds no id twice', (existing, id) => {
    const next = recordRecentId(existing, id)
    expect(new Set(next).size).toBe(next.length)
  })

  fcTest.prop([idsArb, idArb], PROPERTY_PARAMS)(
    'keeps the order of what it did not touch',
    (existing, id) => {
      // Everything that survives, minus the id just recorded, must appear in
      // its original relative order — the list is a recency ranking, so a
      // record may only move ONE entry.
      const next = recordRecentId(existing, id).filter((each) => each !== id)
      const before = existing.filter((each, i) => existing.indexOf(each) === i && each !== id)
      expect(next).toEqual(before.slice(0, next.length))
    },
  )

  fcTest.prop([fc.array(idArb, { minLength: 1 })], PROPERTY_PARAMS)(
    'recording every id in turn leaves the last one first',
    (ids) => {
      const result = ids.reduce<readonly string[]>((acc, id) => recordRecentId(acc, id), [])
      expect(result[0]).toBe(ids[ids.length - 1])
    },
  )
})
