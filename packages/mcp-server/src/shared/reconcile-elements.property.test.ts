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
import { describe, expect, it } from 'vitest'
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
  // Optional so the generator sometimes produces a shared id whose past and
  // current sides have different key sets, exercising both the field-add and
  // the current-only-field-deletion path in reconcile-elements.ts.
  note?: string
}

// Small, self-contained arbitrary: only reconcile-elements' field-merge and
// tombstone logic is exercised here, so a minimal element shape is enough.
// IDs are drawn from a small alphabet so past/current element lists collide
// on shared ids often, exercising all three reconcile branches.
const idArb = fc.constantFrom('a', 'b', 'c', 'd', 'e')

const elementArb: fc.Arbitrary<ElementShape> = fc.record(
  {
    id: idArb,
    type: fc.constantFrom('rectangle', 'ellipse', 'text', 'arrow'),
    x: fc.integer({ min: -1000, max: 1000 }),
    y: fc.integer({ min: -1000, max: 1000 }),
    width: fc.integer({ min: 0, max: 1000 }),
    height: fc.integer({ min: 0, max: 1000 }),
    version: fc.integer({ min: 0, max: 100 }),
    isDeleted: fc.boolean(),
    note: fc.string({ maxLength: 5 }),
  },
  { requiredKeys: ['id', 'type', 'x', 'y', 'width', 'height', 'version', 'isDeleted'] },
)

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

// Apply a distinct branch-local edit, addition, and tombstone so branchA and
// branchB actually diverge from their common ancestor before reconcile runs.
function divergeBranch(doc: LoroDoc, opts: { fieldSuffix: string; addedId: string }): void {
  const list = doc.getMovableList('elements')
  for (let i = 0; i < list.length; i++) {
    const m = list.get(i) as LoroMap
    const type = m.get('type')
    if (typeof type === 'string') m.set('type', `${type}${opts.fieldSuffix}`)
  }
  if (list.length > 0) {
    const last = list.get(list.length - 1) as LoroMap
    last.set('isDeleted', true)
  }
  const added = list.insertContainer(list.length, new LoroMap())
  added.set('id', opts.addedId)
  added.set('type', 'rectangle')
  doc.commit()
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

      // Every live (non-tombstone) past element must be present and match
      // past field-by-field in both directions: every past field must be
      // present with the past value, AND no current-only field may survive
      // (a field present on the current side but absent from past must have
      // been deleted, not merely left unchecked).
      for (const [id, pastEl] of pastById) {
        const liveEl = resultById.get(id)
        expect(liveEl, `expected id ${id} to be present after reconcile`).toBeDefined()
        expect(liveEl, `id ${id} must match past exactly`).toEqual(pastEl)
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

      // Give each branch independent local edits before reconciling, so the
      // two replicas actually diverge (distinct field changes, an addition,
      // and a tombstone) instead of staying identical snapshots all the way
      // through. A no-op reconcile would not satisfy convergence once the
      // branches disagree going in.
      divergeBranch(branchA, { fieldSuffix: '-A', addedId: '__branchA_only__' })
      divergeBranch(branchB, { fieldSuffix: '-B', addedId: '__branchB_only__' })

      reconcileElementsOnDoc(branchA, past)
      branchA.commit()
      reconcileElementsOnDoc(branchB, past)
      branchB.commit()

      // Sync the two independently reconciled replicas bidirectionally.
      syncDocs(branchA, branchB)

      expect(snapshot(branchB)).toEqual(snapshot(branchA))
    },
  )

  // KNOWN BUG — documented, not yet fixed. The convergence property above
  // asserts the two replicas agree, but equality alone blesses a corrupted
  // outcome: when two branches each independently reconcile a past-only id
  // (step (3) of reconcileElementsOnDoc inserts a fresh LoroMap container),
  // the CRDT merge keeps BOTH containers, leaving two live elements sharing
  // one id. Both replicas are identically corrupted, so equality still
  // passes. This test states the invariant that SHOULD hold — post-sync ids
  // are unique — and is marked `it.fails` because it does not yet. When the
  // reconcile dup-id hazard is fixed, `it.fails` starts failing (i.e. the
  // body passes), which flags this to be flipped to a plain `it`.
  // Tracked: reconcile-concurrent-dup-id.
  it.fails('post-sync live ids are unique across concurrently reconciled branches', () => {
    // Ancestor lacks id "a"; past has it — so both branches take the
    // insert-new-container path for the same id independently.
    const ancestor = docOf([])
    const past = docOf([
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, version: 1 },
    ])
    const branchA = forkDoc(ancestor)
    const branchB = forkDoc(ancestor)

    reconcileElementsOnDoc(branchA, past)
    branchA.commit()
    reconcileElementsOnDoc(branchB, past)
    branchB.commit()
    syncDocs(branchA, branchB)

    const live = snapshot(branchA).filter((el) => el.isDeleted !== true)
    const uniqueIds = new Set(live.map((el) => el.id))
    expect(uniqueIds.size).toBe(live.length)
  })
})
