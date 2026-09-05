// @vitest-environment node
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { recordSeen, SEEN_CAP } from './seen-documents.js'

// The pure half only — no storage, so this runs in node. The localStorage
// contract is `seen-documents.test.ts`.
const PROPERTY_PARAMS = withDefaults({ numRuns: 200 })

// A dense small alphabet: ids drawn from `fc.string()` would collide almost
// never, so re-recording — the branch that decides whether the cap counts a
// document twice — would not be reached.
const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')
const digestArb = fc.constantFrom('d1', 'd2', 'd3')
const writesArb = fc.array(fc.tuple(idArb, digestArb))

const replay = (writes: readonly (readonly [string, string])[]) =>
  writes.reduce<Record<string, string>>((acc, [id, digest]) => recordSeen(acc, id, digest), {})

describe('recordSeen (fast-check)', () => {
  fcTest.prop([writesArb], PROPERTY_PARAMS)('never exceeds the cap', (writes) => {
    expect(Object.keys(replay(writes)).length).toBeLessThanOrEqual(SEEN_CAP)
  })

  fcTest.prop([writesArb, idArb, digestArb], PROPERTY_PARAMS)(
    'always retains the most recently recorded document',
    (writes, id, digest) => {
      expect(recordSeen(replay(writes), id, digest)[id]).toBe(digest)
    },
  )

  fcTest.prop([writesArb, idArb, digestArb], PROPERTY_PARAMS)(
    'is idempotent: the same document and digest twice leaves the same record',
    (writes, id, digest) => {
      const once = recordSeen(replay(writes), id, digest)
      expect(recordSeen(once, id, digest)).toEqual(once)
    },
  )

  fcTest.prop([writesArb], PROPERTY_PARAMS)(
    'answers, for every id it kept, the digest of that id LAST write',
    (writes) => {
      const record = replay(writes)
      const lastWrite = new Map<string, string>(writes.map(([id, digest]) => [id, digest]))
      for (const [id, digest] of Object.entries(record)) {
        expect(digest).toBe(lastWrite.get(id))
      }
    },
  )

  fcTest.prop([writesArb], PROPERTY_PARAMS)('never invents a document nobody wrote', (writes) => {
    const written = new Set<string>(writes.map(([id]) => id))
    for (const id of Object.keys(replay(writes))) expect(written.has(id)).toBe(true)
  })
})
