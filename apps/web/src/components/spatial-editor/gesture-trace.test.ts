// @vitest-environment node
/**
 * The gesture flight recorder's own behaviour: a bounded ring, coalesced
 * moves, and a serialized form that replays through the navigation reducer
 * deterministically.
 *
 * Replay is the point of the whole module. A phone reproduction arrives as
 * pasted JSON, and because `reduceNavigation` is pure, folding it over the
 * recorded events answers "what did the machine decide" without the phone,
 * the browser, or the session that recorded it.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { fc, fcTest } from '../../test-utils/fast-check.js'
import {
  createGestureTrace,
  parseGestureTrace,
  replayNavigation,
  type TraceEntry,
} from './gesture-trace.js'
import {
  createIdleNavigation,
  type NavigationEvent,
  type NavigationState,
  reduceNavigation,
} from './navigation.js'

const HAND_CONTEXT = {
  handMode: true,
  spaceDown: false,
  hitId: undefined,
  anchorPrimaryId: null,
  manipulating: false,
}

function down(pointerId: number, x: number, y: number, timeStamp = 0): NavigationEvent {
  return {
    type: 'pointerdown',
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    point: { x, y },
    timeStamp,
    context: HAND_CONTEXT,
  }
}

function move(pointerId: number, x: number, y: number): NavigationEvent {
  return { type: 'pointermove', pointerId, pointerType: 'touch', point: { x, y } }
}

function up(pointerId: number): NavigationEvent {
  return { type: 'pointerup', pointerId, pointerType: 'touch' }
}

/**
 * Drives the REAL reducer and records what it answered, the way
 * `SpatialEditor` does: the recorder never reduces anything itself, so it
 * cannot disagree with what the component actually performed.
 */
function makeRecorder(trace = createGestureTrace()) {
  let state: NavigationState = createIdleNavigation()
  return {
    trace,
    feed(event: NavigationEvent, at: number) {
      const result = reduceNavigation(state, event)
      trace.recordNavigation({ at, event, before: state, result })
      state = result.state
    },
  }
}

function recordDrag(trace = createGestureTrace(), moves = 3) {
  const recorder = makeRecorder(trace)
  recorder.feed(down(1, 100, 100), 0)
  for (let i = 1; i <= moves; i += 1) recorder.feed(move(1, 100 + i * 10, 100), i)
  recorder.feed(up(1), moves + 1)
  return trace
}

describe('the ring', () => {
  it('keeps the newest entries once capacity is reached', () => {
    const trace = createGestureTrace(3)
    for (let i = 0; i < 10; i += 1) {
      trace.recordDocPointer({
        at: i,
        type: 'pointerdown',
        pointerId: i,
        pointerType: 'touch',
        isPrimary: true,
        x: 0,
        y: 0,
        insideRoot: true,
        target: { tag: 'div' },
      })
    }
    const ids = trace
      .entries()
      .map((entry) => (entry.kind === 'doc-pointer' ? entry.pointerId : -1))
    expect(ids).toEqual([7, 8, 9])
  })

  it('coalesces the moves of one continuing gesture instead of flooding', () => {
    const trace = recordDrag(createGestureTrace(), 50)
    const kinds = trace.entries().map((entry) => entry.kind)
    // down, ONE move entry carrying a counter, up — not 52 entries.
    expect(kinds).toEqual(['navigation', 'navigation', 'navigation'])
    const moveEntry = trace.entries()[1]
    if (moveEntry?.kind !== 'navigation') throw new Error('expected a navigation entry')
    expect(moveEntry.coalescedMoves).toBe(49)
    expect(moveEntry.modeAfter).toBe('panning')
  })

  it('does not coalesce across a mode change', () => {
    const recorder = makeRecorder()
    const trace = recorder.trace
    recorder.feed(down(1, 100, 100), 0)
    recorder.feed(move(1, 110, 100), 1)
    recorder.feed(up(1), 2)
    recorder.feed(down(1, 300, 300, 1000), 3)
    const modes = trace
      .entries()
      .map((entry) => (entry.kind === 'navigation' ? entry.modeAfter : '?'))
    expect(modes).toEqual(['panning', 'panning', 'idle', 'panning'])
  })
})

describe('serialize and replay', () => {
  it('round-trips: the replayed mode sequence is the recorded one', () => {
    const trace = recordDrag()
    // The component resets the machine outside the reducer in one place (the
    // long-press menu firing); a recorded reset must replay as one, or every
    // event after it replays against the wrong state.
    trace.recordReset('long-press-menu', 99)
    const recorder = makeRecorder(trace)
    recorder.feed(down(1, 50, 50, 2000), 100)
    const parsed = parseGestureTrace(trace.serialize())
    const recorded = parsed.entries.flatMap((entry) =>
      entry.kind === 'navigation' ? [entry.modeAfter] : [],
    )
    expect(replayNavigation(parsed.entries)).toEqual(recorded)
  })

  it('carries the bundle identity and the device beside the entries', () => {
    const parsed = parseGestureTrace(createGestureTrace().serialize())
    expect(parsed.format).toBe(1)
    expect(parsed.bundle.length).toBeGreaterThan(0)
    expect(typeof parsed.userAgent).toBe('string')
  })
})

/** A serialized trace with one field replaced, as an older or newer bundle would write it. */
function traceText(patch: Record<string, unknown>): string {
  const trace = recordDrag()
  const envelope = JSON.parse(trace.serialize()) as Record<string, unknown>
  return JSON.stringify({ ...envelope, ...patch })
}

describe('parseGestureTrace refuses what this build cannot replay faithfully', () => {
  it('refuses a trace from an unknown format', () => {
    expect(() => parseGestureTrace(traceText({ format: 0 }))).toThrow(/format 0/)
  })

  it('refuses a trace that carries no format at all', () => {
    expect(() => parseGestureTrace(traceText({ format: undefined }))).toThrow(/no `format`/)
  })

  it('refuses a navigation event this build does not know', () => {
    const entries = [
      {
        kind: 'navigation',
        at: 0,
        coalescedMoves: 0,
        event: { type: 'pointerhover', pointerId: 1 },
        modeBefore: 'idle',
        modeAfter: 'idle',
        effects: [],
        fallThrough: false,
      },
    ]
    expect(() => parseGestureTrace(traceText({ entries }))).toThrow(/entries\[0\]\.event/)
  })

  it('refuses an event carrying a field this build does not know', () => {
    const entries = [
      {
        kind: 'navigation',
        at: 0,
        coalescedMoves: 0,
        event: { type: 'pointerup', pointerId: 1, pointerType: 'touch', pressure: 0.5 },
        modeBefore: 'idle',
        modeAfter: 'idle',
        effects: [],
        fallThrough: false,
      },
    ]
    expect(() => parseGestureTrace(traceText({ entries }))).toThrow(/pressure/)
  })

  it('refuses text that is not JSON with a message saying so', () => {
    expect(() => parseGestureTrace('Copy trace')).toThrow(/not JSON/)
  })
})

describe('the parsed entry type', () => {
  it('reads navigation events as exactly the reducer takes them', () => {
    expectTypeOf<
      Extract<TraceEntry, { kind: 'navigation' }>['event']
    >().toEqualTypeOf<NavigationEvent>()
  })
})

// Hand-written rather than derived from the trace schema: an arbitrary built
// from the schema under test would lose a variant exactly when the schema did.
const coordinate = fc.integer({ min: -4000, max: 4000 }).map((n) => n / 4)
const pointArbitrary = fc.record({ x: coordinate, y: coordinate })
const pointerIdArbitrary = fc.integer({ min: 0, max: 20 })
const pointerKindArbitrary = fc.constantFrom('mouse' as const, 'pen' as const, 'touch' as const)
const contextArbitrary = fc.record({
  handMode: fc.boolean(),
  spaceDown: fc.boolean(),
  hitId: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  anchorPrimaryId: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
  manipulating: fc.boolean(),
})
const eventArbitrary: fc.Arbitrary<NavigationEvent> = fc.oneof(
  fc.record({
    type: fc.constant('pointerdown' as const),
    pointerId: pointerIdArbitrary,
    pointerType: pointerKindArbitrary,
    isPrimary: fc.boolean(),
    button: fc.integer({ min: 0, max: 4 }),
    point: pointArbitrary,
    timeStamp: fc.nat(100_000),
    context: contextArbitrary,
  }),
  fc.record({
    type: fc.constant('pointermove' as const),
    pointerId: pointerIdArbitrary,
    pointerType: pointerKindArbitrary,
    point: pointArbitrary,
  }),
  fc.record({
    type: fc.constant('pointerup' as const),
    pointerId: pointerIdArbitrary,
    pointerType: pointerKindArbitrary,
  }),
  fc.record({ type: fc.constant('external-press' as const), pointerId: pointerIdArbitrary }),
  fc.record({
    type: fc.constant('pointercancel' as const),
    pointerId: pointerIdArbitrary,
    pointerType: pointerKindArbitrary,
  }),
)
const targetArbitrary = fc.record(
  {
    tag: fc.constantFrom('div', 'button', 'svg'),
    testId: fc.string({ maxLength: 8 }),
    role: fc.constantFrom('button', 'menuitem'),
    overlay: fc.string({ maxLength: 8 }),
  },
  { requiredKeys: ['tag'] },
)
type Step = (trace: ReturnType<typeof createGestureTrace>) => void
const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.tuple(eventArbitrary, fc.nat(10_000)).map(([event, at]): Step => {
    return (trace) => {
      const before = createIdleNavigation()
      trace.recordNavigation({ at, event, before, result: reduceNavigation(before, event) })
    }
  }),
  fc
    .record({
      at: fc.nat(10_000),
      type: fc.constantFrom('pointerdown', 'pointerup'),
      pointerId: pointerIdArbitrary,
      pointerType: fc.string({ maxLength: 6 }),
      isPrimary: fc.boolean(),
      x: coordinate,
      y: coordinate,
      insideRoot: fc.boolean(),
      target: targetArbitrary,
    })
    .map(
      (entry): Step =>
        (trace) =>
          trace.recordDocPointer(entry),
    ),
  fc
    .record({
      at: fc.nat(10_000),
      pointerId: pointerIdArbitrary,
      pointerType: fc.string({ maxLength: 6 }),
      target: targetArbitrary,
    })
    .map(
      (entry): Step =>
        (trace) =>
          trace.recordOverlayRejected(entry),
    ),
  fc.tuple(pointerIdArbitrary, fc.nat(10_000)).map(
    ([pointerId, at]): Step =>
      (trace) =>
        trace.recordLostCapture(pointerId, at),
  ),
  fc.tuple(fc.string({ maxLength: 12 }), fc.nat(10_000)).map(
    ([reason, at]): Step =>
      (trace) =>
        trace.recordReset(reason, at),
  ),
)

describe('serialize then parse', () => {
  fcTest.prop([fc.array(stepArbitrary, { minLength: 1, maxLength: 30 })])(
    'answers the recorded entries unchanged',
    (steps) => {
      const trace = createGestureTrace()
      for (const step of steps) step(trace)
      expect(parseGestureTrace(trace.serialize()).entries).toEqual(trace.entries())
    },
  )
})
