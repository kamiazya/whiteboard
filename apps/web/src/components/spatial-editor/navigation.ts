/**
 * Pure navigation state machine: pointer events in, next state plus the
 * effects the caller must perform. The other half of this editor's gesture
 * handling — moving, resizing, connecting, editing text — has lived in
 * `gestures.ts` as a reducer for a long time; navigation (pan, pinch, the
 * hand tool, the touch gather, long-press arming) stayed as loose refs in
 * the component, and that is where every gesture defect this editor has
 * shipped was found.
 *
 * What the refs could not express is a LIFETIME. Twelve of them are read and
 * written across thirty-five early returns in four handlers, so "this
 * gesture is over" is a fact nothing states and every branch has to
 * remember. The two most recent defects were both that: a touch point that
 * outlived the gesture that recorded it, and a press memory consulted long
 * after the press it described. Here the whole of navigation is ONE value,
 * and `NAVIGATION_MEMORY_KEYS` names the only field allowed to survive a
 * return to idle.
 *
 * What this module deliberately does NOT own: the marquee, selection, node
 * gestures, and the long-press TIMER. Those stay with the caller, which is
 * why every event can answer `fallThrough` — "this was not navigation, run
 * your own path". The seam is what lets the component adopt this reducer by
 * wrapping its handlers rather than rewriting them.
 *
 * Screen points are ROOT-LOCAL throughout, the same convention
 * `clientPointToRootLocal` produces; this module never sees a client
 * coordinate or a canvas one.
 */

import type { Point } from '../../lib/spatial/viewport.js'
import { computePinchUpdate } from './touch-pinch.js'

/**
 * Window for double-press detection, for BOTH of this editor's double
 * presses — hand mode's zoom, which this module decides, and the select
 * tool's edit-or-create, which the component decides past the `fallThrough`
 * seam. Matches the common OS double-click interval; not user-configurable
 * today.
 *
 * One definition because a user pressing twice quickly is performing one
 * gesture whichever tool is selected. Two constants of the same value is how
 * that stops being true silently: tuning the window for one leaves the other
 * where it was, and nothing fails.
 */
export const DOUBLE_PRESS_WINDOW_MS = 400

/**
 * How far apart two presses may land and still be one double press.
 *
 * Sized like the OS gesture it imitates rather than like finger jitter — a
 * deliberate double tap is not a still finger, and a jitter-sized value
 * would reject most real ones. Hand mode is what needs this: every other
 * double press in this editor is bound to a logical target (a node id, an
 * edge id) and so is already bounded in space; hand mode has no target to
 * key on, and without a distance any two presses inside the window read as
 * one gesture.
 */
export const DOUBLE_PRESS_SLOP_PX = 40

/** How much closer a hand-mode double press gets. */
export const DOUBLE_PRESS_ZOOM_FACTOR = 2

/** The pointer kinds this machine distinguishes. Pen behaves as a mouse. */
export type PointerKind = 'mouse' | 'pen' | 'touch'

export type NavigationMode =
  | { readonly kind: 'idle' }
  /** One pointer is dragging the canvas: hand tool, middle button, or Space. */
  | { readonly kind: 'panning'; readonly pointerId: number; readonly last: Point }
  /** Two or more fingers own the viewport until every one of them lifts. */
  | { readonly kind: 'pinching' }
  /**
   * A finger is holding a selection open while further taps add to it. The
   * anchor is the finger that was already down; members are the taps.
   */
  | {
      readonly kind: 'gathering'
      readonly anchorId: number
      readonly memberIds: ReadonlySet<number>
    }

/** What a press remembers about the press before it, for double-press detection. */
export interface HandPressMemory {
  readonly at: number
  readonly point: Point
}

export interface NavigationState {
  readonly mode: NavigationMode
  /** Touches this machine believes are down, in arrival order. */
  readonly touches: ReadonlyMap<number, Point>
  /** Every pointer believed down, touch or not — what a capture handback is judged against. */
  readonly down: ReadonlySet<number>
  /**
   * The only field that may outlive a gesture, and it is memory rather than
   * state: a double press is by definition a fact about the PREVIOUS press.
   */
  readonly lastHandPress: HandPressMemory | null
}

/**
 * The fields of `NavigationState` that survive a return to idle.
 *
 * Declared rather than implied so a test can state the invariant over the
 * whole type: everything NOT named here is gesture-scoped and must be back
 * to its empty value the moment the machine is idle. Adding a field without
 * deciding which side it falls on is exactly how the last two defects got
 * in.
 */
export const NAVIGATION_MEMORY_KEYS = ['lastHandPress'] as const

export function createIdleNavigation(): NavigationState {
  return { mode: { kind: 'idle' }, touches: new Map(), down: new Set(), lastHandPress: null }
}

/**
 * Everything the caller knows that this machine cannot: which tool is
 * selected, what is under the pointer, whether a manipulation is in flight.
 * Passed per-press rather than held, because all of it can change between
 * one press and the next.
 */
export interface PressContext {
  /** The hand tool is selected: every plain press pans, nodes included. */
  readonly handMode: boolean
  /** Space is held: a plain press pans whatever the tool is. */
  readonly spaceDown: boolean
  /** The id of the node under this press, or undefined for empty canvas. */
  readonly hitId: string | undefined
  /**
   * The selection anchor a gather would extend, or null when there is none.
   * Null makes a gather impossible, which is why entering hand mode — which
   * clears the selection — cannot gather.
   */
  readonly anchorPrimaryId: string | null
  /** A node gesture (move/resize/connect) is in flight and would need cancelling. */
  readonly manipulating: boolean
}

export type NavigationEvent =
  | {
      readonly type: 'pointerdown'
      readonly pointerId: number
      readonly pointerType: PointerKind
      /** Only ever true for a touch when no other touch is down — see reducer. */
      readonly isPrimary: boolean
      readonly button: number
      readonly point: Point
      readonly timeStamp: number
      readonly context: PressContext
    }
  | {
      readonly type: 'pointermove'
      readonly pointerId: number
      readonly pointerType: PointerKind
      readonly point: Point
    }
  | { readonly type: 'pointerup'; readonly pointerId: number; readonly pointerType: PointerKind }
  /**
   * A press that never reached this machine's handler — an overlay control
   * taking the pointer and capturing it on the root. Its RELEASE does arrive
   * here, because capture redirects the rest of the sequence, so without
   * this the machine would see an up for a pointer it never saw go down and
   * a capture handback would read as a loss.
   */
  | { readonly type: 'external-press'; readonly pointerId: number }
  | {
      readonly type: 'pointercancel'
      readonly pointerId: number
      readonly pointerType: PointerKind
    }

export type NavigationEffect =
  /** Move the viewport by a screen-space delta. */
  | { readonly kind: 'pan'; readonly deltaScreen: Point }
  /** Zoom about a screen point, holding the canvas point under it still. */
  | { readonly kind: 'zoom-at'; readonly anchorScreen: Point; readonly factor: number }
  /** A pinch step: pan, then zoom about the anchor. Ordered as written. */
  | {
      readonly kind: 'pinch'
      readonly panDeltaScreen: Point
      readonly anchorScreen: Point
      readonly factor: number
    }
  | { readonly kind: 'capture'; readonly pointerIds: readonly number[] }
  /**
   * This machine no longer holds capture for anything. Emitted on the
   * releases that END a gesture and on a cancel — never on a finger lifting
   * out of a gather or a pinch, where the others are still down and still
   * captured. Deciding it from an editor-wide "is something active" flag is
   * what let a lifted finger's ordinary handback answer for a finger that
   * was still down.
   */
  | { readonly kind: 'release-capture' }
  | { readonly kind: 'arm-long-press'; readonly pointerId: number; readonly screen: Point }
  | { readonly kind: 'clear-long-press' }
  /** Abandon whatever node gesture was in flight; the sequence became navigation. */
  | { readonly kind: 'cancel-manipulation' }
  | { readonly kind: 'clear-marquee' }
  /**
   * Drop the caller's own armed double press. Navigation never sets it — the
   * select-tool double press is decided past the `fallThrough` seam — but a
   * gesture that becomes navigation has to abandon it, or the release that
   * ends the pan would resolve as the second half of a press the user
   * abandoned two fingers ago.
   */
  | { readonly kind: 'clear-press-memory' }
  /** Add the pressed node to the selection the anchor is holding open. */
  | { readonly kind: 'gather'; readonly anchorPrimaryId: string; readonly hitId: string }

export interface NavigationResult {
  readonly state: NavigationState
  /** Ordered — performed left-to-right by the caller. */
  readonly effects: readonly NavigationEffect[]
  /**
   * The event was not navigation's to answer: the caller runs its own
   * handler (marquee, node gesture, click semantics) as if this machine had
   * not been consulted.
   */
  readonly fallThrough: boolean
  /**
   * The caller must call `preventDefault` on the DOM event. Not an effect,
   * because it acts on the event rather than on the app: a pan or a
   * double-press zoom has to stop the browser's own drag and
   * selection defaults, and only the caller holds the event to stop.
   */
  readonly preventDefault?: boolean
}

function withTouch(
  touches: ReadonlyMap<number, Point>,
  id: number,
  point: Point,
): ReadonlyMap<number, Point> {
  const next = new Map(touches)
  next.set(id, point)
  return next
}

function withoutTouch(touches: ReadonlyMap<number, Point>, id: number): ReadonlyMap<number, Point> {
  if (!touches.has(id)) return touches
  const next = new Map(touches)
  next.delete(id)
  return next
}

function withDown(down: ReadonlySet<number>, id: number, present: boolean): ReadonlySet<number> {
  if (down.has(id) === present) return down
  const next = new Set(down)
  if (present) next.add(id)
  else next.delete(id)
  return next
}

/**
 * The gesture-scoped half of the state, emptied. `lastHandPress` is carried
 * because it is memory, not state — see NAVIGATION_MEMORY_KEYS.
 */
function toIdle(state: NavigationState): NavigationState {
  return {
    mode: { kind: 'idle' },
    touches: new Map(),
    down: state.down,
    lastHandPress: state.lastHandPress,
  }
}

function isDoublePress(memory: HandPressMemory | null, at: number, point: Point): boolean {
  if (memory === null) return false
  if (at - memory.at > DOUBLE_PRESS_WINDOW_MS) return false
  return Math.hypot(point.x - memory.point.x, point.y - memory.point.y) <= DOUBLE_PRESS_SLOP_PX
}

/**
 * A second finger on a node EXTENDS the selection rather than starting a
 * pinch — the one-handed way to build a multi-selection on a touch screen.
 *
 * Answers `undefined` when this press is not a gather, so the caller carries
 * on to the pinch and one-finger rules. Gathering is a SELECTION act, not a
 * drag: whatever the anchor had begun to move is abandoned, because carrying
 * a half-applied delta into the new multi-selection would jump every node
 * gathered afterwards by an offset the user never gave it.
 */
function tryGather(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointerdown' }>,
  effects: NavigationEffect[],
): { next: NavigationState; result: NavigationResult | undefined } | undefined {
  const { context } = event
  const next = state
  if (next.touches.size !== 2 && next.mode.kind !== 'gathering') return undefined
  const gathered = context.anchorPrimaryId === null ? undefined : context.hitId
  const anchorId =
    next.mode.kind === 'gathering'
      ? next.mode.anchorId
      : ([...next.touches.keys()].find((id) => id !== event.pointerId) ?? null)
  if (gathered !== undefined && anchorId !== null && context.anchorPrimaryId !== null) {
    const beganNow = next.mode.kind !== 'gathering'
    const memberIds = new Set(
      next.mode.kind === 'gathering' ? next.mode.memberIds : new Set<number>(),
    )
    memberIds.add(event.pointerId)
    // Gathering is a selection act, not a drag. Whatever the anchor had
    // begun to move is abandoned: carrying a half-applied delta into the
    // new multi-selection would jump every node gathered afterwards by
    // an offset the user never gave it.
    if (beganNow && context.manipulating) effects.push({ kind: 'cancel-manipulation' })
    effects.push(
      { kind: 'clear-marquee' },
      { kind: 'clear-press-memory' },
      { kind: 'clear-long-press' },
    )
    effects.push({
      kind: 'gather',
      anchorPrimaryId: context.anchorPrimaryId,
      hitId: gathered,
    })
    const gathering: NavigationState = {
      ...next,
      mode: { kind: 'gathering', anchorId, memberIds },
      touches: withoutTouch(next.touches, event.pointerId),
      lastHandPress: null,
    }
    return { next: gathering, result: { state: gathering, effects, fallThrough: false } }
  }
  return undefined
}

function reducePointerDown(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointerdown' }>,
): NavigationResult {
  const effects: NavigationEffect[] = []
  let next: NavigationState = { ...state, down: withDown(state.down, event.pointerId, true) }
  if (event.pointerType === 'touch') {
    const touch = reduceTouchPress(next, event, effects)
    if (touch.result !== undefined) return touch.result
    next = touch.next
  }
  return reducePanPress(next, event, effects)
}

/**
 * The touch half of a press: what a second finger MEANS, and what a single
 * one arms.
 *
 * Answers a `result` when the touch owns the press outright — a pinch, a
 * gather, or a finger arriving while one of those is already running — and
 * otherwise the state a pan decision continues from. Separated from the pan
 * half because the two share only the `down` bookkeeping: everything below is
 * about buttons and modifier keys, which a finger does not have.
 */
function reduceTouchPress(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointerdown' }>,
  effects: NavigationEffect[],
): { next: NavigationState; result: NavigationResult | undefined } {
  const { context } = event
  let next = state
  // A touch pointer is `isPrimary` only while no other touch is active
  // (Pointer Events 3, sec. 4.2), so this is the browser stating that
  // nothing else is down. Anything still tracked belongs to a gesture
  // whose release never reached us — a finger lifted over an element
  // outside the editor, a cancel delivered somewhere else. Left in place
  // it is not inert: the next one-finger press would make the map size 2
  // and be read as the second finger of a pinch.
  if (event.isPrimary) next = { ...toIdle(next), down: next.down }

  next = { ...next, touches: withTouch(next.touches, event.pointerId, event.point) }

  // A pinch owns the viewport until every finger lifts; later fingers are
  // tracked so their release is accounted for, and otherwise inert.
  if (next.mode.kind === 'pinching')
    return { next, result: { state: next, effects, fallThrough: false } }

  if (next.mode.kind === 'gathering') {
    // Already gathering: a further finger is another tap, never a pinch
    // participant, so it must not sit among the pinch candidates.
    next = { ...next, touches: withoutTouch(next.touches, event.pointerId) }
  }

  const gathered = tryGather(next, event, effects)
  if (gathered !== undefined) return gathered

  if (next.touches.size === 2) {
    // The second finger converts whatever the first started — marquee,
    // node move, double-press arming — into navigation.
    if (context.manipulating) effects.push({ kind: 'cancel-manipulation' })
    effects.push(
      { kind: 'clear-marquee' },
      { kind: 'clear-press-memory' },
      { kind: 'clear-long-press' },
    )
    // Capture BOTH fingers, not only the one that arrived second: an
    // uncaptured first finger crossing outside the root would stop
    // delivering its move and up events, leaving a stale entry that would
    // misread a later one-finger press as a pinch participant.
    effects.push({ kind: 'capture', pointerIds: [...next.touches.keys()] })
    const pinching: NavigationState = {
      ...next,
      mode: { kind: 'pinching' },
      lastHandPress: null,
    }
    return { next: pinching, result: { state: pinching, effects, fallThrough: false } }
  }

  // Armed under the hand tool too: its menu is the annotation layer's
  // verbs, which a reader panning around a canvas has as much reason to
  // reach as one selecting on it. The pan the press starts below is not
  // stranded by the timer's teardown, because a finger that travels
  // clears the timer first and a finger that does not has not panned.
  if (next.touches.size === 1) {
    effects.push({ kind: 'clear-long-press' })
    effects.push({ kind: 'arm-long-press', pointerId: event.pointerId, screen: event.point })
  }
  return { next, result: undefined }
}

/**
 * Whether this press pans, and what a double press under the hand tool does
 * instead.
 */
function reducePanPress(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointerdown' }>,
  effects: NavigationEffect[],
): NavigationResult {
  const { context } = event
  let next = state
  // empty space marquee-selects instead. The hand tool makes EVERY plain
  // press a pan, nodes included: it is the one-handed touch navigation mode,
  // where a second finger is not available to promote the gesture.
  const pans = event.button === 1 || (event.button === 0 && (context.spaceDown || context.handMode))
  if (!pans) return { state: next, effects, fallThrough: true }

  if (context.handMode && event.button === 0 && !context.spaceDown) {
    if (isDoublePress(next.lastHandPress, event.timeStamp, event.point)) {
      effects.push({
        kind: 'zoom-at',
        anchorScreen: event.point,
        factor: DOUBLE_PRESS_ZOOM_FACTOR,
      })
      return {
        state: { ...next, lastHandPress: null },
        effects,
        fallThrough: false,
        preventDefault: true,
      }
    }
    next = { ...next, lastHandPress: { at: event.timeStamp, point: event.point } }
  }

  return {
    state: { ...next, mode: { kind: 'panning', pointerId: event.pointerId, last: event.point } },
    effects,
    fallThrough: false,
    preventDefault: true,
  }
}

/**
 * A move by one of the two fingers driving a pinch.
 *
 * The PAIR is the two longest-lived fingers — a Map preserves insertion order
 * — and later fingers are tracked so their release is accounted for, but are
 * otherwise inert. Answers `undefined` when this move is not one of the
 * pair's, so the caller falls through to the pan rules.
 */
function advancePinch(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointermove' }>,
): NavigationResult | undefined {
  if (state.mode.kind !== 'pinching' || state.touches.size < 2) return undefined
  const [idA, idB] = [...state.touches.keys()]
  if (idA === undefined || idB === undefined) return undefined
  if (event.pointerId !== idA && event.pointerId !== idB) return undefined
  const a = state.touches.get(idA)
  const b = state.touches.get(idB)
  if (a === undefined || b === undefined) return undefined
  const update = computePinchUpdate(
    { a, b },
    {
      a: event.pointerId === idA ? event.point : a,
      b: event.pointerId === idB ? event.point : b,
    },
  )
  return {
    state: { ...state, touches: withTouch(state.touches, event.pointerId, event.point) },
    effects: [
      {
        kind: 'pinch',
        panDeltaScreen: update.panDelta,
        anchorScreen: update.anchor,
        factor: update.zoomFactor,
      },
    ],
    fallThrough: false,
  }
}

function reducePointerMove(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointermove' }>,
): NavigationResult {
  // A gathering finger has already acted on its press, and the anchor's own
  // gesture was cancelled when gathering began — neither may resume dragging
  // while the other is still down.
  if (state.mode.kind === 'gathering') {
    const involved =
      state.mode.anchorId === event.pointerId || state.mode.memberIds.has(event.pointerId)
    if (involved) return { state, effects: [], fallThrough: false }
  }

  if (event.pointerType === 'touch' && state.touches.has(event.pointerId)) {
    const pinch = advancePinch(state, event)
    if (pinch !== undefined) return pinch
    const tracked = { ...state, touches: withTouch(state.touches, event.pointerId, event.point) }
    // A lone finger left behind by a pinch stays inert until it lifts.
    if (state.mode.kind === 'pinching') {
      return { state: tracked, effects: [], fallThrough: false }
    }
    return reducePanMove(tracked, event)
  }

  return reducePanMove(state, event)
}

function reducePanMove(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointermove' }>,
): NavigationResult {
  if (state.mode.kind !== 'panning') return { state, effects: [], fallThrough: true }
  const delta = {
    x: event.point.x - state.mode.last.x,
    y: event.point.y - state.mode.last.y,
  }
  return {
    state: { ...state, mode: { ...state.mode, last: event.point } },
    effects: [{ kind: 'pan', deltaScreen: delta }],
    fallThrough: false,
  }
}

/**
 * A finger lifting out of a GATHER.
 *
 * Gathering fingers act on the press, so their release carries no meaning —
 * running the click/marquee logic would re-collapse the very selection the
 * gesture just built. The anchor lifting ends the gather.
 *
 * The ANCHOR is checked first, and that ordering is load-bearing rather than
 * incidental. Pointer ids are reused, so a gather that outlived a release
 * this handler never saw can be joined by a new finger carrying the anchor's
 * own id — at which point one id is both anchor and member, the member arm
 * consumes its release, and the gather survives with an anchor that is no
 * longer down. Ending on the anchor cannot leave that behind. In every
 * ordinary gather the two sets are disjoint and the order does not matter.
 *
 * Answers `undefined` when this release is not a gathering finger's.
 */
function releaseGatheringFinger(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointerup' }>,
  down: NavigationState['down'],
  effects: NavigationEffect[],
): NavigationResult | undefined {
  if (state.mode.kind !== 'gathering') return undefined
  // Gathering fingers act on the press, so their release carries no
  // meaning — running the click/marquee logic here would re-collapse the
  // very selection the gesture just built. The anchor lifting ends it.
  //
  // The ANCHOR is checked first, and that ordering is load-bearing rather
  // than incidental. Pointer ids are reused, so a gather that outlived a
  // release this handler never saw can be joined by a new finger carrying
  // the anchor's own id — at which point one id is both anchor and member,
  // the member arm consumes its release, and the gather survives with an
  // anchor that is no longer down. Ending on the anchor cannot leave that
  // behind. In every ordinary gather the two sets are disjoint and the
  // order does not matter.
  if (state.mode.anchorId === event.pointerId) {
    return {
      state: {
        ...state,
        down,
        mode: { kind: 'idle' },
        touches: withoutTouch(state.touches, event.pointerId),
      },
      effects,
      fallThrough: false,
    }
  }
  if (state.mode.memberIds.has(event.pointerId)) {
    const memberIds = new Set(state.mode.memberIds)
    memberIds.delete(event.pointerId)
    return {
      state: { ...state, down, mode: { ...state.mode, memberIds } },
      effects,
      fallThrough: false,
    }
  }
  return undefined
}

function reducePointerUp(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointerup' }>,
): NavigationResult {
  const down = withDown(state.down, event.pointerId, false)
  const effects: NavigationEffect[] = [{ kind: 'clear-long-press' }]

  const gathered = releaseGatheringFinger(state, event, down, effects)
  if (gathered !== undefined) return gathered

  if (event.pointerType === 'touch') {
    const touches = withoutTouch(state.touches, event.pointerId)
    if (state.mode.kind === 'pinching') {
      // Fingers lifting out of a pinch never run the click/marquee release
      // logic — the sequence was navigation, not a gesture.
      return {
        state: {
          ...state,
          down,
          touches,
          mode: touches.size === 0 ? { kind: 'idle' } : state.mode,
        },
        effects,
        fallThrough: false,
      }
    }
    effects.push({ kind: 'release-capture' })
    if (state.mode.kind === 'panning' && state.mode.pointerId === event.pointerId) {
      return {
        state: { ...state, down, touches, mode: { kind: 'idle' } },
        effects,
        fallThrough: false,
      }
    }
    return { state: { ...state, down, touches }, effects, fallThrough: true }
  }

  effects.push({ kind: 'release-capture' })
  if (state.mode.kind === 'panning' && state.mode.pointerId === event.pointerId) {
    return { state: { ...state, down, mode: { kind: 'idle' } }, effects, fallThrough: false }
  }
  return { state: { ...state, down }, effects, fallThrough: true }
}

function reducePointerCancel(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: 'pointercancel' }>,
): NavigationResult {
  const down = withDown(state.down, event.pointerId, false)
  const touches = withoutTouch(state.touches, event.pointerId)
  // Pointer ids are reused, so anything this cancel leaves behind would
  // silently deaden whichever later touch inherits its id.
  const stillPinching = state.mode.kind === 'pinching' && touches.size > 0
  return {
    state: {
      ...state,
      down,
      touches,
      mode: stillPinching ? state.mode : { kind: 'idle' },
    },
    effects: [
      { kind: 'clear-long-press' },
      { kind: 'release-capture' },
      { kind: 'cancel-manipulation' },
    ],
    fallThrough: false,
  }
}

export function reduceNavigation(state: NavigationState, event: NavigationEvent): NavigationResult {
  switch (event.type) {
    case 'pointerdown':
      return reducePointerDown(state, event)
    case 'pointermove':
      return reducePointerMove(state, event)
    case 'pointerup':
      return reducePointerUp(state, event)
    case 'pointercancel':
      return reducePointerCancel(state, event)
    case 'external-press':
      return {
        state: { ...state, down: withDown(state.down, event.pointerId, true) },
        effects: [],
        fallThrough: false,
      }
  }
}
