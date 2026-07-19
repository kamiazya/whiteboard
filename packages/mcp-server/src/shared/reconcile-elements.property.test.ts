/**
 * Property tests for reconcileElementsOnDoc (Slice B2 of the PBT pilot).
 *
 * Fixed properties (do not weaken without re-approving the design):
 *
 * (a) Idempotence — reconciling `current` against the same `past` twice
 *     produces the same elements JSON as reconciling once.
 * (b) Past-state fidelity, defined by id/content — the id -> content map of
 *     live (non-tombstone) elements after reconcile matches past's live
 *     elements field-by-field; ids only in past are inserted; ids only in
 *     current are tombstoned. Current-side tombstones are excluded from the
 *     comparison. Shared-element ORDER is intentionally not asserted:
 *     reconcileElementsOnDoc does not reorder existing entries, and if order
 *     fidelity is ever required that is a new bug to scope separately, not
 *     an assumption baked into this test.
 * (c) Convergence — two branch replicas each reconciled against the same
 *     past, then synced via Loro export/import in both directions, end up
 *     with identical elements JSON.
 */
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { reconcileElementsOnDoc } from './reconcile-elements.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

interface ElementShape {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  version: number
  isDeleted: boolean
}

// Small, self-contained arbitrary: only reconcile-elements' field-merge and
// tombstone logic is exercised here, so a minimal element shape is enough.
// IDs are drawn from a small alphabet so past/current element lists collide
// on shared ids often, exercising all three reconcile branches.
const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e')

const elementArb: fc.Arbitrary<ElementShape> = fc.record({
  id: idArb,
  type: fc.constantFrom('rectangle', 'ellipse', 'text', 'arrow'),
  x: fc.integer({ min: -1000, max: 1000 }),
  y: fc.integer({ min: -1000, max: 1000 }),
  width: fc.integer({ min: 0, max: 1000 }),
  height: fc.integer({ min: 0, max: 1000 }),
  version: fc.integer({ min: 0, max: 100 }),
  isDeleted: fc.boolean(),
})

// Dedupe by id: each list represents "current state", so ids must be unique
// the way a real elements LoroMovableList would be (one live entry per id).
function uniqueByIdArb(): fc.Arbitrary<ElementShape[]> {
  return fc.uniqueArray(elementArb, {
    minLength: 0,
    maxLength: 6,
    selector: (el) => el.id,
  })
}

function docOf(elements: ElementShape[]): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  for (const el of elements) {
    const m = list.insertContainer(list.length, new LoroMap())
    for (const [k, v] of Object.entries(el)) {
      m.set(k, v as Parameters<LoroMap['set']>[1])
    }
  }
  doc.commit()
  return doc
}

type El = Record<string, unknown> & { id: string }

function snapshot(doc: LoroDoc): El[] {
  return doc.getMovableList('elements').toJSON() as El[]
}

function byId<T extends { id: string }>(elements: readonly T[]): Map<string, T> {
  return new Map(elements.map((el) => [el.id, el]))
}

// Fork `doc` into an independent in-memory replica carrying the same history,
// so branch (c) can diverge and later re-converge via export/import.
function forkDoc(doc: LoroDoc): LoroDoc {
  const fork = new LoroDoc()
  fork.import(doc.export({ mode: 'snapshot' }))
  return fork
}

function syncDocs(a: LoroDoc, b: LoroDoc): void {
  a.import(b.export({ mode: 'update', from: a.oplogVersion() }))
  b.import(a.export({ mode: 'update', from: b.oplogVersion() }))
}

describe('reconcileElementsOnDoc property tests', () => {
  fcTest.prop([uniqueByIdArb(), uniqueByIdArb()], withDefaults())(
    '(a) idempotence: reconciling twice against the same past matches reconciling once',
    (currentEls, pastEls) => {
      const once = docOf(currentEls)
      const past = docOf(pastEls)
      reconcileElementsOnDoc(once, past)
      once.commit()
      const onceResult = snapshot(once)

      const twice = docOf(currentEls)
      reconcileElementsOnDoc(twice, past)
      twice.commit()
      reconcileElementsOnDoc(twice, past)
      twice.commit()
      const twiceResult = snapshot(twice)

      expect(twiceResult).toEqual(onceResult)
    },
  )

  fcTest.prop([uniqueByIdArb(), uniqueByIdArb()], withDefaults())(
    '(b) past-state fidelity by id/content, ignoring shared-element order',
    (currentEls, pastEls) => {
      const current = docOf(currentEls)
      const past = docOf(pastEls)
      reconcileElementsOnDoc(current, past)
      current.commit()

      const resultById = byId(snapshot(current))
      const pastById = byId(pastEls)
      const currentById = byId(currentEls)

      // Every live (non-tombstone) past element must be present with matching fields.
      for (const [id, pastEl] of pastById) {
        const liveEl = resultById.get(id)
        expect(liveEl, `expected id ${id} to be present after reconcile`).toBeDefined()
        for (const [k, v] of Object.entries(pastEl)) {
          expect(liveEl?.[k], `field ${k} on id ${id}`).toEqual(v)
        }
      }

      // Every current-only id (not in past, and not already a current-side
      // tombstone) must be tombstoned in the result.
      for (const [id, curEl] of currentById) {
        if (pastById.has(id)) continue
        if (curEl.isDeleted === true) continue
        expect(resultById.get(id)?.isDeleted, `expected id ${id} to be tombstoned`).toBe(true)
      }
    },
  )

  fcTest.prop([uniqueByIdArb(), uniqueByIdArb()], withDefaults())(
    '(c) convergence: two branches forked from a common ancestor, each reconciled against the same past, converge after sync',
    (commonEls, pastEls) => {
      const past = docOf(pastEls)

      // Both branches share op history up to this point (same peer/container
      // ids for pre-existing elements), matching how a real branch checkout
      // forks a live doc before diverging.
      const ancestor = docOf(commonEls)
      const branchA = forkDoc(ancestor)
      const branchB = forkDoc(ancestor)

      reconcileElementsOnDoc(branchA, past)
      branchA.commit()
      reconcileElementsOnDoc(branchB, past)
      branchB.commit()

      // Sync the two independently reconciled replicas bidirectionally.
      syncDocs(branchA, branchB)

      expect(snapshot(branchB)).toEqual(snapshot(branchA))
    },
  )
})
