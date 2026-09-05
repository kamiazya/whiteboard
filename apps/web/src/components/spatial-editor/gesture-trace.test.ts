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
import { describe, expect, it } from 'vitest'
import { createGestureTrace, replayNavigation, type TraceEntry } from './gesture-trace.js'
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
    const parsed = JSON.parse(trace.serialize()) as { entries: TraceEntry[] }
    const recorded = parsed.entries.flatMap((entry) =>
      entry.kind === 'navigation' ? [entry.modeAfter] : [],
    )
    expect(replayNavigation(parsed.entries)).toEqual(recorded)
  })

  it('carries the bundle identity and the device beside the entries', () => {
    const parsed = JSON.parse(createGestureTrace().serialize()) as Record<string, unknown>
    expect(typeof parsed.bundle).toBe('string')
    expect((parsed.bundle as string).length).toBeGreaterThan(0)
    expect(typeof parsed.userAgent).toBe('string')
  })
})
