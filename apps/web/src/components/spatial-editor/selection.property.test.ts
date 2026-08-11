// Model-based property over the selection state machine: random event
// sequences, invariants checked after EVERY step. This is the executable
// form of "selection = {primary} ∪ extras, coherent by construction" — the
// invariant that used to be maintained per call site and broke there (a
// three-node selection dragged by an extra moved only two nodes).
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  EMPTY_SELECTION,
  reduceSelection,
  type SelectionEvent,
  type SelectionState,
  selectionMembers,
} from './selection.js'

const ID_POOL = ['a', 'b', 'c', 'd'] as const
const idArb = fc.constantFrom(...ID_POOL)

const eventArb: fc.Arbitrary<SelectionEvent> = fc.oneof(
  fc.record({ type: fc.constant('set-primary' as const), id: fc.option(idArb, { nil: null }) }),
  fc.record({ type: fc.constant('press' as const), id: idArb }),
  fc.record({ type: fc.constant('toggle-member' as const), id: idArb }),
  // Deliberately NOT uniqueArray: callers are trusted not to pass
  // duplicates, but the reducer is the invariant guarantor — a polite
  // generator here is exactly the vacuousness the mutation-check rule warns
  // about (a duplicate-blind generator missed a real I1 violation).
  fc.record({
    type: fc.constant('set-members' as const),
    ids: fc.array(idArb, { maxLength: ID_POOL.length + 2 }),
  }),
  fc.record({ type: fc.constant('promote' as const), id: idArb }),
  fc.record({ type: fc.constant('collapse-extras' as const) }),
  fc.record({ type: fc.constant('clear' as const) }),
  fc.record({
    type: fc.constant('drop-locked' as const),
    lockedIds: fc.uniqueArray(idArb, { maxLength: ID_POOL.length }).map((ids) => new Set(ids)),
  }),
)

function checkInvariants(state: SelectionState, trail: readonly SelectionEvent[]): void {
  const label = trail.map((e) => e.type).join(' → ')
  // I1: the primary is never inside the extras.
  if (state.primaryId !== null) {
    expect(state.extraIds.has(state.primaryId), `I1 after ${label}`).toBe(false)
  }
  // I2: extras are non-empty only while a primary exists.
  if (state.extraIds.size > 0) {
    expect(state.primaryId, `I2 after ${label}`).not.toBeNull()
  }
}

describe('selection state machine (model-based)', () => {
  fcTest.prop([fc.array(eventArb, { maxLength: 30 })], withDefaults())(
    'invariants hold after every step of any event sequence',
    (events) => {
      let state = EMPTY_SELECTION
      const trail: SelectionEvent[] = []
      for (const event of events) {
        state = reduceSelection(state, event)
        trail.push(event)
        checkInvariants(state, trail)
      }
    },
  )

  // The pressed id is DERIVED from the warmed-up state (member by index /
  // first non-member) rather than filtered with fc.pre — a precondition
  // over independently-generated ids rejects most samples and times the
  // runner out without testing anything.
  fcTest.prop(
    [fc.array(eventArb, { maxLength: 20 }), fc.nat({ max: ID_POOL.length - 1 })],
    withDefaults(),
  )('a press on a current member never changes WHO is selected, only who leads', (warmup, pick) => {
    let state = EMPTY_SELECTION
    for (const event of warmup) state = reduceSelection(state, event)
    if (selectionMembers(state).length === 0) {
      state = reduceSelection(state, { type: 'set-members', ids: ['a', 'b', 'c'] })
    }
    const members = selectionMembers(state)
    const pressed = members[pick % members.length] as string

    const after = reduceSelection(state, { type: 'press', id: pressed })
    expect(new Set(selectionMembers(after))).toEqual(new Set(members))
    expect(after.primaryId).toBe(pressed)
  })

  fcTest.prop([fc.array(eventArb, { maxLength: 20 })], withDefaults())(
    'a press on a non-member collapses the extras',
    (warmup) => {
      let state = EMPTY_SELECTION
      for (const event of warmup) state = reduceSelection(state, event)
      let outsider: string | undefined = ID_POOL.find(
        (id) => !new Set(selectionMembers(state)).has(id),
      )
      if (outsider === undefined) {
        state = reduceSelection(state, { type: 'toggle-member', id: 'a' })
        outsider = 'a'
      }

      const after = reduceSelection(state, { type: 'press', id: outsider })
      expect(after.extraIds.size).toBe(0)
    },
  )

  fcTest.prop(
    [fc.array(eventArb, { maxLength: 20 }), fc.array(idArb, { maxLength: 6 })],
    withDefaults(),
  )('set-members selects exactly the given ids (deduped), first as primary', (warmup, ids) => {
    let state = EMPTY_SELECTION
    for (const event of warmup) state = reduceSelection(state, event)

    const after = reduceSelection(state, { type: 'set-members', ids })
    expect(selectionMembers(after)).toEqual([...new Set(ids)])
  })

  fcTest.prop(
    [fc.array(eventArb, { maxLength: 20 }), fc.uniqueArray(idArb, { maxLength: 4 })],
    withDefaults(),
  )('after drop-locked, no locked id remains selected', (warmup, locked) => {
    let state = EMPTY_SELECTION
    for (const event of warmup) state = reduceSelection(state, event)

    const lockedIds = new Set<string>(locked)
    const after = reduceSelection(state, { type: 'drop-locked', lockedIds })
    for (const member of selectionMembers(after)) {
      expect(lockedIds.has(member)).toBe(false)
    }
  })
})

describe('set-members duplicate ids', () => {
  // Shrunk counterexample pinned per the PBT guideline: duplicates put the
  // primary inside the extras, violating I1.
  it("dedupes ['a', 'a'] instead of selecting 'a' as both primary and extra", () => {
    const after = reduceSelection(EMPTY_SELECTION, { type: 'set-members', ids: ['a', 'a'] })
    expect(after).toEqual({ primaryId: 'a', extraIds: new Set() })
  })
})

describe('selection reducer identity', () => {
  it('returns the same object for a no-op transition', () => {
    const state: SelectionState = { primaryId: 'a', extraIds: new Set(['b']) }
    expect(reduceSelection(state, { type: 'press', id: 'a' })).toBe(state)
    expect(reduceSelection(EMPTY_SELECTION, { type: 'clear' })).toBe(EMPTY_SELECTION)
    expect(reduceSelection(EMPTY_SELECTION, { type: 'collapse-extras' })).toBe(EMPTY_SELECTION)
  })
})
