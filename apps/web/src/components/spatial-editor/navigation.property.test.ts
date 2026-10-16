/**
 * The navigation machine's invariants, over generated event sequences.
 *
 * This is the layer the browser properties cannot be. `hand-pan-dead-zone`
 * and `hand-pan-gesture-history` mount a real editor and drive real pointer
 * events, which is what lets them see an overlay eating a press — and it
 * costs a browser per run, so they search 60 to 120 sequences. The same
 * search here is pure function calls: 2000 sequences in about the time one
 * browser run takes. Different blind spots, so both stay.
 *
 * The invariant that matters most is the LIFETIME one, because it is the
 * defect family this module was extracted to close: with every pointer up,
 * `down` empties, and when it does nothing a gesture owned may remain. In
 * the twelve refs this replaces there was no single place to state that,
 * and the last two defects were both a field that outlived its gesture.
 */
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { assertLedger, emptyTally, type SurfaceCoverage } from '../../test-utils/coverage-ledger.js'
import { fc } from '../../test-utils/fast-check.js'
import {
  createIdleNavigation,
  DOUBLE_PRESS_SLOP_PX,
  NAVIGATION_MEMORY_KEYS,
  type NavigationEffect,
  type NavigationEvent,
  type NavigationMode,
  type NavigationResult,
  type NavigationState,
  reduceNavigation,
} from './navigation.js'

/**
 * Effects earn a ledger and events do not, and that is a MEASUREMENT rather
 * than a preference. `reduceNavigation` switches exhaustively on
 * `event.type`, so a fifth event member fails the build with TS2366 before
 * any test runs — and `.claude/rules/coverage-ledger.md` says a surface the
 * typechecker already guards is done. Effects and modes are produced, never
 * switched over exhaustively: adding one and never producing it compiles,
 * passes, and reports the same green as yesterday. Verified by adding a
 * member of each union and reading the compiler: 1 error for an event, 0
 * for an effect, 0 for a mode.
 */
const EFFECT_COVERAGE = {
  pan: 'covered',
  'zoom-at': 'covered',
  pinch: 'covered',
  capture: 'covered',
  'release-capture': 'covered',
  'arm-long-press': 'covered',
  'clear-long-press': 'covered',
  'cancel-manipulation': 'covered',
  'clear-marquee': 'covered',
  'clear-press-memory': 'covered',
  gather: 'covered',
} satisfies Record<NavigationEffect['kind'], SurfaceCoverage>

const MODE_COVERAGE = {
  idle: 'covered',
  panning: 'covered',
  pinching: 'covered',
  gathering: 'covered',
} satisfies Record<NavigationMode['kind'], SurfaceCoverage>

const effectTally = emptyTally(EFFECT_COVERAGE)
const modeTally = emptyTally(MODE_COVERAGE)

/**
 * How often the generator reached the arrangement the anchor/member
 * collision needs: a gather, its anchor released without the machine
 * hearing, its id reused by a new finger. Counted rather than assumed,
 * because reverting the fix for it left this property GREEN the first time
 * — the mutation check caught a generator too sparse to reach its own
 * subject, which is the failure that reads exactly like a passing guard.
 */
let anchorReusedCount = 0

/**
 * How often the generator reached a double press the machine ACCEPTED.
 * Counted for the same reason as the line above, and because this one was
 * measured at 4-8 per run against siblings in the thousands — the ledger
 * entry below passed on a margin of four, and reported `zoom-at` uncovered
 * on about one run in sixteen. A ledger that fails at random teaches the
 * reader to re-run it, which is the opposite of what it is for.
 */
let doublePressZoomCount = 0

// Every invariant below folds its sequences through `drive`, so the tallies are the whole file's.
afterAllFloor('every test', () => {
  assertLedger('NavigationEffect kind', EFFECT_COVERAGE, effectTally)
  assertLedger('NavigationMode kind', MODE_COVERAGE, modeTally)
  expect(
    anchorReusedCount,
    'the generator never reached a gather whose anchor id was reused — the invariant about a mode holding a pointer that is not down has nothing to check',
    // A floor, not a target: measured 100, 107 and 107 when it was written,
    // and 68-73 once `double-press` took a share of the step draw — still
    // twice the floor, which is why the number below did not move with it.
    // The number matters because
    // it MOVED — a uniform draw of the step kinds reached this arrangement 4
    // times in 12000 sequences and the mutation check came back green, which
    // is exactly what a guard that never reaches its subject looks like from
    // the outside.
  ).toBeGreaterThan(30)
  expect(
    doublePressZoomCount,
    'the generator never reached an accepted double press — the zoom-at ledger entry below is passing on luck',
    // A floor, not a target, sized the same way: measured 556, 567 and 556
    // across three runs with the `double-press` step, against 4-8 without it.
  ).toBeGreaterThan(180)
})

const rawPointArb = fc.record({
  x: fc.integer({ min: 0, max: 400 }),
  y: fc.integer({ min: 0, max: 700 }),
})

/**
 * A small pointer pool, so ids repeat and a sequence can strand one finger,
 * reuse its id, or lift one that was never down. A wide pool would make
 * every event independent and reach none of those.
 */
const POINTER_IDS = [1, 2, 3] as const
const pointerIdArb = fc.constantFrom(...POINTER_IDS)

/**
 * A pointer's type is fixed for its life: a finger does not become a mouse.
 * Drawing it per EVENT generated sequences where the same id went down as a
 * touch and came up as a mouse, and all three lifetime invariants "failed"
 * on them — correctly, since `pointerup` only untracks a touch, but about an
 * input the platform cannot produce. Fixing the arbitrary is the honest
 * repair; weakening the invariant would have hidden the real thing it says.
 */
const pointerTypesArb = fc.dictionary(
  fc.constantFrom('1', '2', '3'),
  fc.constantFrom('touch' as const, 'mouse' as const),
  { minKeys: 3, maxKeys: 3 },
)

/**
 * Where a press lands, as a CHOICE rather than a coordinate: near the
 * previous press, or anywhere.
 *
 * A uniform point over the whole surface almost never puts two consecutive
 * presses inside the 40px double-press slop, so the first version of this
 * property produced `zoom-at` zero times in 2000 sequences — and its ledger
 * said so, which is the ledger doing its job. The fix is a denser generator,
 * never a lowered assertion.
 */
const pressPlacementArb = fc.oneof(
  { weight: 1, arbitrary: rawPointArb.map((point) => ({ nearLast: false, point }) as const) },
  {
    // Jitter sized just outside the slop, so a "near" press lands inside it
    // more often than not while still generating the rejection case. At +/-60
    // it was inside about a third of the time and `zoom-at` fell to zero once
    // the step weights changed around it — which the ledger reported, in the
    // words of the entry that had gone stale.
    weight: 1,
    arbitrary: fc
      .record({
        x: fc.integer({ min: -50, max: 50 }),
        y: fc.integer({ min: -50, max: 50 }),
      })
      .map((point) => ({ nearLast: true, point }) as const),
  },
)

const contextArb = fc.record({
  handMode: fc.boolean(),
  spaceDown: fc.boolean(),
  // A gather needs BOTH a node under the press and a selection anchor to
  // extend, so a uniform draw of each makes the gather arms rare. Biased
  // toward present for the same reason the step kinds are weighted.
  hitId: fc.option(fc.constantFrom('n1', 'n2'), { nil: undefined, freq: 8 }),
  anchorPrimaryId: fc.option(fc.constantFrom('n0', 'n1'), { nil: null, freq: 8 }),
  manipulating: fc.boolean(),
})

/**
 * One step: an event plus how far the clock advanced before it. The clock is
 * accumulated by the runner rather than generated per event, because a
 * double press is a fact about the INTERVAL between two presses and
 * independent timestamps would rarely put two inside the window.
 */
const stepArb = fc.record({
  // Biased short. A double press is two presses inside a 400ms window with
  // whatever steps fell between them, and a uniform 0-600ms interval left
  // `zoom-at` at 4-5 per 2000 sequences — zero in one local run out of six,
  // and once on CI, which the ledger reported. Two draws in three under
  // 150ms lift it to 9-13 (measured 12, 9, 13) while the long tail still
  // generates the "too late" rejection.
  dt: fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 150 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 600 }) },
  ),
  pointerId: pointerIdArb,
  /**
   * Weighted, not uniform. The arrangement that matters most here — a
   * gather, its anchor's release lost, its id reused, then released — needs
   * four specific steps in order, and a uniform draw reached it 4 times in
   * 12000 sequences and never with the release that completes it. Measured
   * by counting, after the mutation check came back green over a property
   * that looked like it covered the case.
   */
  kind: fc.oneof(
    { weight: 5, arbitrary: fc.constant('pointerdown' as const) },
    { weight: 4, arbitrary: fc.constant('pointerup' as const) },
    // Not an event: the platform's release this handler never hears — a
    // finger lifted over an element outside the root, a cancel delivered
    // somewhere else. It removes the pointer from the PLATFORM's set only,
    // which is what makes id reuse reachable.
    { weight: 4, arbitrary: fc.constant('lost-up' as const) },
    { weight: 2, arbitrary: fc.constant('pointermove' as const) },
    { weight: 1, arbitrary: fc.constant('pointercancel' as const) },
    // A compound step, not an event: while a gather is live, lose its
    // anchor's release, let a new finger take the freed id, and release
    // that. Every part is something a device does; what the generator
    // supplies is the ORDER, which is the whole difficulty — weighting the
    // individual kinds got this arrangement from 4 occurrences in 12000
    // sequences to 24, and the mutation check stayed green at both, because
    // reaching the collision is not the same as reaching the release that
    // completes it. Steering toward an interesting state is what
    // `fc.commands`' own `check` does; the ORACLE stays independent.
    { weight: 3, arbitrary: fc.constant('reuse-mode-anchor' as const) },
    // A compound step, like the one above: press, release, press again, with
    // hand mode on and the plain button both times. Every part is something
    // a one-handed touch user does; what the generator supplies is the
    // ARRANGEMENT, which is what a uniform draw almost never reaches —
    // `handMode && !spaceDown && button === 0` on two consecutive presses is
    // 1 in 64 before the interval and the distance are asked about, and the
    // first press's pointer has to be released in between or the second one
    // promotes to a pinch instead. Measured: 4-8 accepted double presses per
    // run without this step, 556-567 with it.
    { weight: 1, arbitrary: fc.constant('double-press' as const) },
    // A press that reached an overlay control rather than this machine. It
    // joins the down set without a touch, and its RELEASE does arrive here —
    // so it is generated for the lifetime invariants, which would otherwise
    // never see a pointer the machine believes down but never tracked.
    { weight: 2, arbitrary: fc.constant('external-press' as const) },
  ),
  placement: pressPlacementArb,
  /**
   * Where the second press of a `double-press` lands relative to the first.
   * Sized just outside the slop on each axis, so the step generates the
   * ACCEPT and the REJECT case in roughly equal measure — a compound step
   * that always satisfied the rule would leave "never claims a double press
   * across more than the slop" with nothing to reject.
   */
  rePressOffset: fc.record({
    x: fc.integer({ min: -50, max: 50 }),
    y: fc.integer({ min: -50, max: 50 }),
  }),
  button: fc.constantFrom(0, 1),
  isPrimary: fc.boolean(),
  context: contextArb,
})

const sequenceArb = fc.record({
  types: pointerTypesArb,
  steps: fc.array(stepArb, { minLength: 1, maxLength: 22 }),
})

type Sequence = typeof sequenceArb extends fc.Arbitrary<infer T> ? T : never

/** A structural snapshot, for asserting the reducer did not mutate its input. */
function snapshot(state: NavigationState) {
  return JSON.stringify({
    mode:
      state.mode.kind === 'gathering'
        ? { ...state.mode, memberIds: [...state.mode.memberIds] }
        : state.mode,
    touches: [...state.touches.entries()],
    down: [...state.down],
    lastHandPress: state.lastHandPress,
  })
}

interface Observation {
  readonly before: NavigationState
  readonly after: NavigationState
  readonly event: NavigationEvent
  readonly effects: readonly NavigationEffect[]
}

/** Folds a generated sequence, handing every step to `check`. */
function drive(sequence: Sequence, check: (observation: Observation) => void) {
  let state = createIdleNavigation()
  let clock = 0
  let lastPoint = { x: 200, y: 350 }
  /**
   * What the PLATFORM has down, which is not what the reducer believes. The
   * two diverge exactly when a release goes missing, and keeping them apart
   * is what lets this generator produce only sequences a real device could:
   * a pointer cannot go down twice without a release, and cannot be released
   * twice. Without the constraint the property failed on a duplicate
   * pointerdown for a pointer already down — a real invariant violation
   * reachable only through id reuse, reported about an input the platform
   * cannot produce.
   */
  const platformDown = new Set<number>()

  /** One event through the reducer, with the purity check and the tallies. */
  const apply = (event: NavigationEvent) => {
    const before = state
    const beforeSnapshot = snapshot(before)
    const result = reduceNavigation(before, event)
    expect(snapshot(before), 'the reducer mutated the state it was handed').toBe(beforeSnapshot)
    modeTally[result.state.mode.kind] += 1
    for (const effect of result.effects) {
      effectTally[effect.kind] += 1
      if (effect.kind === 'zoom-at') doublePressZoomCount += 1
    }
    if (
      result.state.mode.kind === 'gathering' &&
      result.state.mode.memberIds.has(result.state.mode.anchorId)
    ) {
      anchorReusedCount += 1
    }
    check({ before, after: result.state, event, effects: result.effects })
    state = result.state
  }

  for (const step of sequence.steps) {
    clock += step.dt
    const point = step.placement.nearLast
      ? { x: lastPoint.x + step.placement.point.x, y: lastPoint.y + step.placement.point.y }
      : step.placement.point

    if (step.kind === 'reuse-mode-anchor') {
      if (state.mode.kind !== 'gathering') continue
      const id = state.mode.anchorId
      if (sequence.types[String(id)] !== 'touch') continue
      // The platform released it; the machine never heard.
      platformDown.delete(id)
      // A new finger takes the freed id. Not primary: others are still down.
      platformDown.add(id)
      apply({
        type: 'pointerdown',
        pointerId: id,
        pointerType: 'touch',
        isPrimary: false,
        button: step.button,
        point,
        timeStamp: clock,
        context: step.context,
      })
      lastPoint = point
      platformDown.delete(id)
      apply({ type: 'pointerup', pointerId: id, pointerType: 'touch' })
      continue
    }

    if (step.kind === 'double-press') {
      // Only from a quiet hand: a second pointer still down would make the
      // re-press a pinch, which is a real arrangement the plain draw already
      // produces and not the one this step exists to reach.
      if (platformDown.size > 0) continue
      const id = step.pointerId
      const type = sequence.types[String(id)] ?? 'touch'
      // Hand mode with the plain button and no Space is the whole precondition
      // the reducer checks; everything else about the context stays generated.
      const context = { ...step.context, handMode: true, spaceDown: false }
      const second = { x: point.x + step.rePressOffset.x, y: point.y + step.rePressOffset.y }
      for (const at of [point, second]) {
        platformDown.add(id)
        apply({
          type: 'pointerdown',
          pointerId: id,
          pointerType: type,
          isPrimary: true,
          button: 0,
          point: at,
          timeStamp: clock,
          context,
        })
        lastPoint = at
        platformDown.delete(id)
        apply({ type: 'pointerup', pointerId: id, pointerType: type })
        // `dt` again, as the INTERVAL between the two presses — the same
        // 0-600 draw the window at 400ms splits either side of.
        clock += step.dt
      }
      continue
    }

    if (step.kind === 'external-press') {
      if (platformDown.has(step.pointerId)) continue
      platformDown.add(step.pointerId)
      apply({ type: 'external-press', pointerId: step.pointerId })
      continue
    }

    const pointerType = sequence.types[String(step.pointerId)] ?? 'touch'
    if (step.kind === 'pointerdown' && platformDown.has(step.pointerId)) continue
    if (step.kind !== 'pointerdown' && step.kind !== 'pointermove') {
      if (!platformDown.has(step.pointerId)) continue
    }
    if (step.kind === 'pointerdown') platformDown.add(step.pointerId)
    else if (step.kind !== 'pointermove') platformDown.delete(step.pointerId)
    // The release the reducer never hears about: the platform forgets the
    // pointer, the machine does not.
    if (step.kind === 'lost-up') continue

    const event: NavigationEvent =
      step.kind === 'pointerdown'
        ? {
            type: 'pointerdown',
            pointerId: step.pointerId,
            pointerType,
            isPrimary: step.isPrimary,
            button: step.button,
            point,
            timeStamp: clock,
            context: step.context,
          }
        : step.kind === 'pointermove'
          ? { type: 'pointermove', pointerId: step.pointerId, pointerType, point }
          : { type: step.kind, pointerId: step.pointerId, pointerType }
    if (step.kind === 'pointerdown') lastPoint = point
    apply(event)
  }
}

describe('navigation invariants', () => {
  it('nothing a gesture owns outlives the last pointer going up', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        drive(sequence, ({ after, event }) => {
          if (after.down.size > 0) return
          // The one field allowed to survive is memory, not state, and it is
          // named in one place so this assertion can say which.
          expect(NAVIGATION_MEMORY_KEYS).toEqual(['lastHandPress'])
          expect(
            { mode: after.mode.kind, touches: after.touches.size },
            `state outlived the gesture after ${event.type}`,
          ).toEqual({ mode: 'idle', touches: 0 })
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('never tracks a touch it does not believe is down', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        drive(sequence, ({ after }) => {
          expect([...after.touches.keys()].filter((id) => !after.down.has(id))).toEqual([])
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('only ever drives a mode whose pointers are still down', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        drive(sequence, ({ after }) => {
          if (after.mode.kind === 'panning') expect(after.down.has(after.mode.pointerId)).toBe(true)
          if (after.mode.kind === 'gathering')
            expect(after.down.has(after.mode.anchorId)).toBe(true)
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('a primary touch press leaves exactly its own finger tracked', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        drive(sequence, ({ after, event }) => {
          if (event.type !== 'pointerdown') return
          if (event.pointerType !== 'touch' || !event.isPrimary) return
          // The browser only marks a touch primary when no other touch is
          // active, so this is the reconciliation point: whatever was
          // tracked belonged to a gesture whose release never arrived.
          expect([...after.touches.keys()]).toEqual([event.pointerId])
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('pans by exactly the distance the pointer moved, never a fraction of it', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        drive(sequence, ({ before, after, event, effects }) => {
          const pans = effects.filter((effect) => effect.kind === 'pan')
          if (pans.length === 0) return
          expect(pans).toHaveLength(1)
          expect(before.mode.kind).toBe('panning')
          expect(after.mode.kind).toBe('panning')
          if (before.mode.kind !== 'panning' || event.type !== 'pointermove') return
          expect(pans[0]).toEqual({
            kind: 'pan',
            deltaScreen: {
              x: event.point.x - before.mode.last.x,
              y: event.point.y - before.mode.last.y,
            },
          })
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('never claims a double press across more than the slop', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        drive(sequence, ({ before, event, effects }) => {
          const zooms = effects.filter((effect) => effect.kind === 'zoom-at')
          if (zooms.length === 0) return
          expect(event.type).toBe('pointerdown')
          if (event.type !== 'pointerdown') return
          const memory = before.lastHandPress
          expect(memory).not.toBeNull()
          if (memory === null) return
          expect(
            Math.hypot(event.point.x - memory.point.x, event.point.y - memory.point.y),
            'a double press was claimed between two presses further apart than the slop',
          ).toBeLessThanOrEqual(DOUBLE_PRESS_SLOP_PX)
        })
      }),
      { numRuns: 2000 },
    )
  })
})

/**
 * The multi-finger arms — a gather that keeps growing, a pinch joined by a
 * third finger, the finger a pinch leaves behind — judged against a MODEL of
 * what each finger means, written from the spec rather than from the reducer.
 *
 * The sequences above cannot be that oracle: they mix mice with fingers and
 * lose releases on purpose, which is what the lifetime invariants need and
 * what makes "which finger is the anchor" unknowable from outside. Here every
 * pointer is a finger, every release is heard, and the tool is fixed for the
 * whole sequence the way it is for a real hand on a screen — so the model can
 * say exactly which finger anchors a gather, which ones joined it, and when a
 * pinch is over.
 */
const FINGERS = [1, 2, 3, 4] as const

const fingerStepArb = fc.record({
  finger: fc.constantFrom(...FINGERS),
  kind: fc.oneof(
    { weight: 4, arbitrary: fc.constant('down' as const) },
    { weight: 4, arbitrary: fc.constant('up' as const) },
    { weight: 3, arbitrary: fc.constant('move' as const) },
  ),
  // Mostly on a node, since a gather needs one under every finger that joins.
  hitId: fc.option(fc.constantFrom('n1', 'n2', 'n3'), { nil: undefined, freq: 3 }),
  point: rawPointArb,
})

const fingerSequenceArb = fc.record({
  // Hand mode clears the selection, so it never has an anchor to gather onto.
  // One sequence in four, since only the other three can reach a gather.
  handMode: fc.oneof(
    { weight: 1, arbitrary: fc.constant(true) },
    { weight: 3, arbitrary: fc.constant(false) },
  ),
  steps: fc.array(fingerStepArb, { minLength: 2, maxLength: 24 }),
})

/** What the model says the fingers are doing. */
interface FingerModel {
  /** Fingers the machine should hold as pinch candidates. */
  tracked: Set<number>
  gather: { anchor: number; members: Set<number> } | null
  pinching: boolean
}

/** How often the run reached each multi-finger arm, so a sparse draw cannot pass vacuously. */
const fingerReach = {
  secondMemberJoined: 0,
  memberReleasedMidGather: 0,
  bystanderReleasedMidGather: 0,
  thirdFingerInPinch: 0,
  strandedPinchMove: 0,
}

afterAllFloor(['every finger matches the model of what it means'], () => {
  // Floors, not targets: each sits under the lowest of 8,000 sampled runs
  // (minimum / median: secondMemberJoined 172/234, memberReleased 145/201,
  // bystander 9/25, thirdFinger 349/454, stranded 12/32), so a generator
  // change that stops reaching an arm fails here by name rather than passing
  // over it. A floor read off a few runs sat on bystander's minimum.
  expect(fingerReach.secondMemberJoined, 'no gather ever grew past one member').toBeGreaterThan(80)
  expect(
    fingerReach.memberReleasedMidGather,
    'no member lifted while its gather held',
  ).toBeGreaterThan(60)
  expect(fingerReach.bystanderReleasedMidGather, 'no non-member lifted mid-gather').toBeGreaterThan(
    4,
  )
  expect(
    fingerReach.thirdFingerInPinch,
    'no pinch was ever joined by a third finger',
  ).toBeGreaterThan(150)
  expect(fingerReach.strandedPinchMove, 'no finger a pinch left behind ever moved').toBeGreaterThan(
    8,
  )
})

type FingerStep = (typeof fingerSequenceArb extends fc.Arbitrary<infer T>
  ? T
  : never)['steps'][number]

/** What the model says a finger landing means, checked against what the machine did. */
function modelPress(model: FingerModel, finger: number, onNode: boolean, result: NavigationResult) {
  const gathered = result.effects.some((effect) => effect.kind === 'gather')
  if (model.pinching) {
    fingerReach.thirdFingerInPinch += 1
    expect(result.fallThrough, 'a finger joining a pinch reached the caller').toBe(false)
    model.tracked.add(finger)
  } else if (model.gather !== null) {
    expect(gathered, 'a finger mid-gather gathered iff it landed on a node').toBe(onNode)
    if (onNode) {
      fingerReach.secondMemberJoined += 1
      model.gather.members.add(finger)
    }
  } else if (model.tracked.size === 1) {
    const [other] = model.tracked
    expect(gathered, 'a second finger gathered iff it landed on a node').toBe(onNode)
    if (onNode && other !== undefined) {
      model.gather = { anchor: other, members: new Set([finger]) }
    } else {
      model.pinching = true
      model.tracked.add(finger)
    }
  } else {
    expect(gathered, 'a lone finger gathered').toBe(false)
    model.tracked.add(finger)
  }
}

function pressFinger(
  model: FingerModel,
  handMode: boolean,
  isPrimary: boolean,
  step: FingerStep,
  state: NavigationState,
  clock: number,
): NavigationState {
  const result = reduceNavigation(state, {
    type: 'pointerdown',
    pointerId: step.finger,
    pointerType: 'touch',
    isPrimary,
    button: 0,
    point: step.point,
    timeStamp: clock,
    context: {
      handMode,
      spaceDown: false,
      hitId: step.hitId,
      anchorPrimaryId: handMode ? null : 'n0',
      manipulating: false,
    },
  })
  // The browser marks a touch primary only when no other is down, so a
  // primary press is the start of a fresh hand.
  if (isPrimary) Object.assign(model, { tracked: new Set(), gather: null, pinching: false })
  modelPress(model, step.finger, step.hitId !== undefined && !handMode, result)
  return result.state
}

function gathers(model: FingerModel, finger: number): boolean {
  const { gather } = model
  return gather !== null && (gather.anchor === finger || gather.members.has(finger))
}

function moveFinger(model: FingerModel, step: FingerStep, state: NavigationState): NavigationState {
  const { finger } = step
  const result = reduceNavigation(state, {
    type: 'pointermove',
    pointerId: finger,
    pointerType: 'touch',
    point: step.point,
  })
  if (gathers(model, finger)) {
    expect(result, 'a gathering finger dragged').toEqual({ state, effects: [], fallThrough: false })
  }
  if (model.pinching && model.tracked.has(finger)) {
    if (model.tracked.size === 1) fingerReach.strandedPinchMove += 1
    expect(result.fallThrough, 'a pinching finger’s move reached the caller').toBe(false)
  }
  return result.state
}

function releaseFinger(
  model: FingerModel,
  finger: number,
  state: NavigationState,
): NavigationState {
  const inGather = gathers(model, finger)
  const result = reduceNavigation(state, {
    type: 'pointerup',
    pointerId: finger,
    pointerType: 'touch',
  })
  const { gather } = model
  if (gather !== null) {
    if (gather.anchor === finger) {
      model.gather = null
      model.tracked.delete(finger)
    } else if (gather.members.has(finger)) {
      fingerReach.memberReleasedMidGather += 1
      gather.members.delete(finger)
    } else {
      fingerReach.bystanderReleasedMidGather += 1
    }
    const consumed = 'a gathering finger’s release was not consumed, or a bystander’s was'
    expect(result.fallThrough, consumed).toBe(!inGather)
  } else if (model.pinching) {
    expect(result.fallThrough, 'a release out of a pinch reached the caller').toBe(false)
    model.tracked.delete(finger)
    if (model.tracked.size === 0) model.pinching = false
  } else {
    model.tracked.delete(finger)
  }
  return result.state
}

/** One generated step, kept to what a real hand can do: no finger lands twice or lifts unpressed. */
function stepFinger(
  model: FingerModel,
  handMode: boolean,
  platformDown: Set<number>,
  step: FingerStep,
  state: NavigationState,
  clock: number,
): NavigationState {
  const { finger } = step
  if (step.kind === 'down') {
    if (platformDown.has(finger)) return state
    const isPrimary = platformDown.size === 0
    platformDown.add(finger)
    return pressFinger(model, handMode, isPrimary, step, state, clock)
  }
  if (!platformDown.has(finger)) return state
  if (step.kind === 'move') return moveFinger(model, step, state)
  platformDown.delete(finger)
  return releaseFinger(model, finger, state)
}

describe('multi-finger navigation', () => {
  it('every finger matches the model of what it means', () => {
    fc.assert(
      fc.property(fingerSequenceArb, ({ handMode, steps }) => {
        const model: FingerModel = { tracked: new Set(), gather: null, pinching: false }
        const platformDown = new Set<number>()
        let state = createIdleNavigation()
        let clock = 0
        for (const step of steps) {
          clock += 50
          state = stepFinger(model, handMode, platformDown, step, state, clock)
          const expected = model.pinching
            ? 'pinching'
            : model.gather !== null
              ? 'gathering'
              : 'other'
          const actual =
            state.mode.kind === 'pinching' || state.mode.kind === 'gathering'
              ? state.mode.kind
              : 'other'
          expect(actual, 'the machine’s mode disagrees with the model').toBe(expected)
          if (model.gather !== null && state.mode.kind === 'gathering') {
            expect({ anchor: state.mode.anchorId, members: state.mode.memberIds }).toEqual(
              model.gather,
            )
          }
          expect(
            [...state.touches.keys()].sort(),
            'the machine holds a different set of pinch candidates than the model',
          ).toEqual([...model.tracked].sort())
        }
      }),
      { numRuns: 2000 },
    )
  })
})
