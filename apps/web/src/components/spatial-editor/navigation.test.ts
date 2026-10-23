// @vitest-environment node
/**
 * The navigation machine's behaviour, stated at the model level.
 *
 * Every case here is behaviour `SpatialEditor.tsx` ships, but this file is
 * NOT a restatement of the browser suite: several arms are pinned here and
 * nowhere else — the double-press window and slop at their exact bounds, the
 * hand tool's sole claim on the double press, a gather that grows past one
 * member, a finger a pinch leaves behind, and a release that is not the
 * panning pointer's. The browser tests drive these arms without asserting
 * them, so loosening any one leaves every browser file green.
 * `navigation.property.test.ts` holds the multi-finger arms against a model.
 *
 * The two most recent defects are restated here as model-level cases (a
 * double press bounded in space, a stranded touch dropped on the next
 * primary press) so that a future edit to the reducer fails HERE, in
 * milliseconds and by name, rather than in a browser property that has to
 * search for it.
 */
import { describe, expect, it } from 'vitest'
import {
  createIdleNavigation,
  DOUBLE_PRESS_SLOP_PX,
  NAVIGATION_MEMORY_KEYS,
  type NavigationEvent,
  type NavigationState,
  type PressContext,
  reduceNavigation,
} from './navigation.js'

const plainContext: PressContext = {
  handMode: false,
  spaceDown: false,
  hitId: undefined,
  anchorPrimaryId: null,
  manipulating: false,
}

const handContext: PressContext = { ...plainContext, handMode: true }

function down(
  pointerId: number,
  point: { x: number; y: number },
  options: {
    readonly context?: PressContext
    readonly timeStamp?: number
    readonly isPrimary?: boolean
    readonly pointerType?: 'touch' | 'mouse'
    readonly button?: number
  } = {},
): NavigationEvent {
  return {
    type: 'pointerdown',
    pointerId,
    pointerType: options.pointerType ?? 'touch',
    isPrimary: options.isPrimary ?? pointerId === 1,
    button: options.button ?? 0,
    point,
    timeStamp: options.timeStamp ?? 0,
    context: options.context ?? handContext,
  }
}

function move(pointerId: number, point: { x: number; y: number }): NavigationEvent {
  return { type: 'pointermove', pointerId, pointerType: 'touch', point }
}

function up(pointerId: number): NavigationEvent {
  return { type: 'pointerup', pointerId, pointerType: 'touch' }
}

/** Folds a sequence, keeping every effect in order alongside the final state. */
function run(events: readonly NavigationEvent[], from = createIdleNavigation()) {
  let state = from
  const effects = []
  let fallThrough = false
  for (const event of events) {
    const result = reduceNavigation(state, event)
    state = result.state
    effects.push(...result.effects)
    fallThrough = result.fallThrough
  }
  return { state, effects, fallThrough }
}

describe('panning', () => {
  it('a hand press then a move pans by the screen delta', () => {
    const { state, effects } = run([down(1, { x: 100, y: 100 }), move(1, { x: 130, y: 80 })])
    expect(effects).toContainEqual({ kind: 'pan', deltaScreen: { x: 30, y: -20 } })
    expect(state.mode).toEqual({ kind: 'panning', pointerId: 1, last: { x: 130, y: 80 } })
  })

  it('a press with neither the hand tool nor Space falls through to the caller', () => {
    const result = reduceNavigation(
      createIdleNavigation(),
      down(1, { x: 100, y: 100 }, { context: plainContext }),
    )
    expect(result.fallThrough).toBe(true)
    expect(result.effects.filter((effect) => effect.kind === 'pan')).toEqual([])
  })

  it('the middle button pans whatever the tool is', () => {
    const { effects } = run([
      down(1, { x: 100, y: 100 }, { context: plainContext, button: 1, pointerType: 'mouse' }),
      { type: 'pointermove', pointerId: 1, pointerType: 'mouse', point: { x: 110, y: 100 } },
    ])
    expect(effects).toContainEqual({ kind: 'pan', deltaScreen: { x: 10, y: 0 } })
  })
})

describe('the hand double press', () => {
  const first = down(1, { x: 100, y: 100 }, { timeStamp: 0 })

  it('zooms when the second press is close in space and time', () => {
    const { effects, state } = run([
      first,
      up(1),
      down(1, { x: 100 + DOUBLE_PRESS_SLOP_PX - 1, y: 100 }, { timeStamp: 100 }),
    ])
    expect(effects).toContainEqual({
      kind: 'zoom-at',
      anchorScreen: { x: 100 + DOUBLE_PRESS_SLOP_PX - 1, y: 100 },
      factor: 2,
    })
    // The press that zoomed does not also pan: nothing is dragging.
    expect(state.mode).toEqual({ kind: 'idle' })
  })

  it('pans when the second press is far away, however close in time', () => {
    const { effects, state } = run([
      first,
      up(1),
      down(1, { x: 100 + DOUBLE_PRESS_SLOP_PX + 1, y: 100 }, { timeStamp: 1 }),
    ])
    expect(effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
    expect(state.mode.kind).toBe('panning')
  })

  // The window and the slop are written as literals, not as the exported
  // constants: a case built from the constant moves with it, so retuning the
  // window to four seconds would leave every case here green.
  it('pans when the second press is late, however close in space', () => {
    const { effects, state } = run([first, up(1), down(1, { x: 100, y: 100 }, { timeStamp: 401 })])
    expect(effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
    expect(state.mode.kind).toBe('panning')
  })

  it('presses a full second apart are two presses, not a double press', () => {
    const { effects } = run([first, up(1), down(1, { x: 100, y: 100 }, { timeStamp: 1000 })])
    expect(effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
  })

  it('zooms on a second press landing exactly at the window and exactly at the slop', () => {
    const atWindow = run([first, up(1), down(1, { x: 100, y: 100 }, { timeStamp: 400 })])
    expect(atWindow.effects.filter((effect) => effect.kind === 'zoom-at')).toHaveLength(1)
    const atSlop = run([first, up(1), down(1, { x: 140, y: 100 }, { timeStamp: 100 })])
    expect(atSlop.effects.filter((effect) => effect.kind === 'zoom-at')).toHaveLength(1)
  })

  it('is a double tap: a mouse or pen double press only pans, so it can be a double click', () => {
    for (const pointerType of ['mouse', 'pen'] as const) {
      const press = (timeStamp: number) =>
        down(1, { x: 100, y: 100 }, { timeStamp, pointerType: pointerType as 'mouse' })
      const mouseUp: NavigationEvent = { type: 'pointerup', pointerId: 1, pointerType: 'mouse' }
      const { effects, state } = run([press(0), mouseUp, press(100)])
      expect(effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
      expect(state.mode.kind).toBe('panning')
    }
  })

  it('belongs to the hand tool alone: a Space or middle-button double press only pans', () => {
    const mouse = (button: number, context: PressContext, timeStamp: number) =>
      down(1, { x: 100, y: 100 }, { button, context, timeStamp, pointerType: 'mouse' })
    const mouseUp: NavigationEvent = { type: 'pointerup', pointerId: 1, pointerType: 'mouse' }
    const space = { ...plainContext, spaceDown: true }
    const spaceDrag = run([mouse(0, space, 0), mouseUp, mouse(0, space, 100)])
    expect(spaceDrag.effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
    expect(spaceDrag.state.mode.kind).toBe('panning')
    const middle = run([mouse(1, handContext, 0), mouseUp, mouse(1, handContext, 100)])
    expect(middle.effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
    expect(middle.state.mode.kind).toBe('panning')
  })
})

describe('two fingers', () => {
  it('take the viewport, capture both, and abandon what one finger started', () => {
    const { state, effects } = run([
      down(1, { x: 100, y: 100 }),
      // `manipulating` describes the moment the SECOND finger arrives, which
      // is when the decision to abandon the node gesture is taken.
      down(
        2,
        { x: 200, y: 100 },
        {
          context: { ...handContext, manipulating: true },
          isPrimary: false,
        },
      ),
    ])
    expect(state.mode).toEqual({ kind: 'pinching' })
    expect(effects).toContainEqual({ kind: 'capture', pointerIds: [1, 2] })
    expect(effects).toContainEqual({ kind: 'cancel-manipulation' })
  })

  it('a move from either finger produces one pinch update', () => {
    const { effects } = run([
      down(1, { x: 100, y: 100 }),
      down(2, { x: 200, y: 100 }, { isPrimary: false }),
      move(1, { x: 80, y: 100 }),
    ])
    const pinches = effects.filter((effect) => effect.kind === 'pinch')
    expect(pinches).toHaveLength(1)
    // The fingers spread from 100px to 120px about a centroid that moved -10.
    expect(pinches[0]).toMatchObject({ factor: 1.2, panDeltaScreen: { x: -10, y: 0 } })
  })

  it('a lone finger left behind by a pinch stays inert until it lifts', () => {
    const { effects, state } = run([
      down(1, { x: 100, y: 100 }),
      down(2, { x: 200, y: 100 }, { isPrimary: false }),
      up(2),
      move(1, { x: 140, y: 100 }),
    ])
    expect(effects.filter((effect) => effect.kind === 'pan')).toEqual([])
    expect(state.mode).toEqual({ kind: 'pinching' })
  })

  it('a finger left behind by a pinch is still navigation’s, not the caller’s', () => {
    const { fallThrough } = run([
      down(1, { x: 100, y: 100 }, { context: plainContext }),
      down(2, { x: 200, y: 100 }, { context: plainContext, isPrimary: false }),
      move(2, { x: 260, y: 100 }),
      up(1),
      move(2, { x: 300, y: 100 }),
    ])
    expect(fallThrough).toBe(false)
  })

  it('a mouse release during a pinch is the caller’s: the mouse was never part of it', () => {
    const { state, fallThrough } = run([
      down(1, { x: 100, y: 100 }),
      down(2, { x: 200, y: 100 }, { isPrimary: false }),
      down(9, { x: 50, y: 50 }, { context: plainContext, pointerType: 'mouse', isPrimary: true }),
      { type: 'pointerup', pointerId: 9, pointerType: 'mouse' },
    ])
    expect(fallThrough).toBe(true)
    expect(state.mode).toEqual({ kind: 'pinching' })
  })
})

describe('a release that is not the panning pointer’s', () => {
  // A press on an overlay control never reaches the machine, but its release
  // does, because the control captures the pointer on the root.
  it('a finger lifting off an overlay leaves a middle-button pan running', () => {
    const { state, effects } = run([
      down(1, { x: 100, y: 100 }, { context: plainContext, button: 1, pointerType: 'mouse' }),
      { type: 'external-press', pointerId: 2 },
      up(2),
      { type: 'pointermove', pointerId: 1, pointerType: 'mouse', point: { x: 130, y: 100 } },
    ])
    expect(state.mode).toMatchObject({ kind: 'panning', pointerId: 1 })
    expect(effects).toContainEqual({ kind: 'pan', deltaScreen: { x: 30, y: 0 } })
  })

  it('a mouse lifting off an overlay leaves a one-finger hand pan running', () => {
    const { state, effects } = run([
      down(1, { x: 100, y: 100 }),
      { type: 'external-press', pointerId: 9 },
      { type: 'pointerup', pointerId: 9, pointerType: 'mouse' },
      move(1, { x: 130, y: 100 }),
    ])
    expect(state.mode).toMatchObject({ kind: 'panning', pointerId: 1 })
    expect(effects).toContainEqual({ kind: 'pan', deltaScreen: { x: 30, y: 0 } })
  })
})

describe('a touch whose release never arrived', () => {
  /** Down, and no up: exactly what a finger lifted outside the root leaves. */
  const stranded = run([down(7, { x: 50, y: 50 }, { isPrimary: false })])

  it('is dropped by the next primary press rather than read as a pinch', () => {
    expect([...stranded.state.touches.keys()]).toEqual([7])
    const next = reduceNavigation(stranded.state, down(1, { x: 300, y: 300 }))
    expect([...next.state.touches.keys()]).toEqual([1])
    expect(next.state.mode.kind).toBe('panning')
  })

  it('would otherwise make the next one-finger drag a pinch', () => {
    // The same press WITHOUT the browser's primary flag — the shape the
    // reconciliation above is guarding against.
    const next = reduceNavigation(stranded.state, down(1, { x: 300, y: 300 }, { isPrimary: false }))
    expect(next.state.mode).toEqual({ kind: 'pinching' })
  })
})

describe('gathering', () => {
  const gatherContext: PressContext = {
    ...plainContext,
    hitId: 'n2',
    anchorPrimaryId: 'n1',
    manipulating: true,
  }

  it('a second finger on a node extends the selection the first is holding', () => {
    const { state, effects } = run([
      down(1, { x: 100, y: 100 }, { context: { ...gatherContext, hitId: 'n1' } }),
      down(2, { x: 200, y: 200 }, { context: gatherContext, isPrimary: false }),
    ])
    expect(effects).toContainEqual({ kind: 'gather', anchorPrimaryId: 'n1', hitId: 'n2' })
    expect(state.mode).toMatchObject({ kind: 'gathering', anchorId: 1 })
  })

  it('cannot happen without a selection anchor, which is why hand mode never gathers', () => {
    const { state, effects } = run([
      down(1, { x: 100, y: 100 }),
      down(2, { x: 200, y: 200 }, { context: { ...handContext, hitId: 'n2' }, isPrimary: false }),
    ])
    expect(effects.filter((effect) => effect.kind === 'gather')).toEqual([])
    expect(state.mode).toEqual({ kind: 'pinching' })
  })

  /** Anchor on n1, first member on n2 — the gather every case below extends. */
  const begun = [
    down(1, { x: 100, y: 100 }, { context: { ...gatherContext, hitId: 'n1' } }),
    down(2, { x: 200, y: 200 }, { context: gatherContext, isPrimary: false }),
  ]

  it('a further finger on empty space is another tap, never a pinch', () => {
    const { state, fallThrough } = run([
      ...begun,
      down(
        3,
        { x: 300, y: 300 },
        { context: { ...gatherContext, hitId: undefined }, isPrimary: false },
      ),
    ])
    expect(state.mode.kind).toBe('gathering')
    expect(fallThrough).toBe(true)
  })

  it('a later gathered finger keeps every earlier one a member, so each release is consumed', () => {
    const third = down(
      3,
      { x: 300, y: 300 },
      { context: { ...gatherContext, hitId: 'n3' }, isPrimary: false },
    )
    const gathered = run([...begun, third])
    expect(gathered.state.mode).toMatchObject({
      kind: 'gathering',
      anchorId: 1,
      memberIds: new Set([2, 3]),
    })
    const lifted = run([up(2)], gathered.state)
    expect(lifted.fallThrough).toBe(false)
    expect(lifted.state.mode).toMatchObject({ kind: 'gathering', memberIds: new Set([3]) })
  })

  it('only the finger that began the gather abandons the manipulation', () => {
    const gathered = run(begun)
    const next = reduceNavigation(
      gathered.state,
      down(3, { x: 300, y: 300 }, { context: { ...gatherContext, hitId: 'n3' }, isPrimary: false }),
    )
    expect(next.effects).toEqual([
      { kind: 'clear-marquee' },
      { kind: 'clear-press-memory' },
      { kind: 'clear-long-press' },
      { kind: 'gather', anchorPrimaryId: 'n1', hitId: 'n3' },
    ])
  })

  it('neither the anchor nor a member drags while the gather holds', () => {
    const gathered = run(begun)
    for (const pointerId of [1, 2]) {
      const result = reduceNavigation(gathered.state, move(pointerId, { x: 400, y: 400 }))
      expect(result).toEqual({ state: gathered.state, effects: [], fallThrough: false })
    }
  })

  it('a finger that joined without gathering anything releases to the caller', () => {
    const { state, fallThrough } = run([
      ...begun,
      down(
        3,
        { x: 300, y: 300 },
        { context: { ...gatherContext, hitId: undefined }, isPrimary: false },
      ),
      up(3),
    ])
    expect(fallThrough).toBe(true)
    expect(state.mode).toMatchObject({ kind: 'gathering', memberIds: new Set([2]) })
  })
})

describe('a gather whose anchor was released without the machine hearing', () => {
  /**
   * Pointer ids are reused. A gather holds an anchor id, so a release this
   * handler never saw leaves that id free for the NEXT finger — which then
   * joins the same gather carrying the anchor's own id, and one id is both
   * the anchor and a member.
   *
   * The release order then decides whether the gather can survive its own
   * anchor. Checking members first consumes the release and leaves a gather
   * whose anchor is not down, which by the machine's own invariant cannot
   * happen; checking the anchor first ends the gather, which is what "the
   * anchor lifting ends it" already says.
   *
   * Found by `navigation.property.test.ts` and pinned here because the
   * property needs four specific steps in order to reach it — an example is
   * the regression guard, the property is what found it.
   */
  const gatherContext: PressContext = {
    ...plainContext,
    hitId: 'n2',
    anchorPrimaryId: 'n1',
  }

  it('ends when that id is pressed again and released', () => {
    const { state } = run([
      down(1, { x: 100, y: 100 }, { context: { ...gatherContext, hitId: 'n1' } }),
      down(3, { x: 200, y: 200 }, { context: gatherContext, isPrimary: false }),
      // No release for finger 1 reaches us; the platform frees its id.
      // A new finger takes it, and is not primary because 3 is still down.
      down(1, { x: 260, y: 240 }, { context: gatherContext, isPrimary: false }),
      up(1),
    ])
    expect(state.mode).toEqual({ kind: 'idle' })
  })

  it('never leaves a mode holding a pointer that is not down', () => {
    const { state } = run([
      down(1, { x: 100, y: 100 }, { context: { ...gatherContext, hitId: 'n1' } }),
      down(3, { x: 200, y: 200 }, { context: gatherContext, isPrimary: false }),
      down(1, { x: 260, y: 240 }, { context: gatherContext, isPrimary: false }),
      up(1),
    ])
    const held =
      state.mode.kind === 'gathering'
        ? [state.mode.anchorId, ...state.mode.memberIds]
        : state.mode.kind === 'panning'
          ? [state.mode.pointerId]
          : []
    expect(held.filter((id) => !state.down.has(id))).toEqual([])
  })
})

describe('long press arming', () => {
  it('is armed for a single finger outside hand mode', () => {
    const { effects } = run([down(1, { x: 10, y: 20 }, { context: plainContext })])
    expect(effects).toContainEqual({
      kind: 'arm-long-press',
      pointerId: 1,
      screen: { x: 10, y: 20 },
    })
  })

  it('is armed under the hand tool too: its menu is the annotation layer, which panning does not put out of reach', () => {
    const { effects } = run([down(1, { x: 10, y: 20 })])
    expect(effects).toContainEqual({
      kind: 'arm-long-press',
      pointerId: 1,
      screen: { x: 10, y: 20 },
    })
  })
})

describe('the idle invariant', () => {
  /**
   * Every field except the ones NAVIGATION_MEMORY_KEYS names is
   * gesture-scoped, so returning to idle must empty all of them. This is the
   * whole reason the machine exists: the defect family it replaces is
   * "a field outlived the gesture that set it", and in a twelve-ref
   * component there was no single place to state this.
   */
  const emptied = (state: NavigationState) => ({
    mode: state.mode.kind,
    touches: state.touches.size,
    down: state.down.size,
  })

  it('a cancel empties everything a gesture owns', () => {
    const { state } = run([
      down(1, { x: 100, y: 100 }),
      down(2, { x: 200, y: 100 }, { isPrimary: false }),
      { type: 'pointercancel', pointerId: 1, pointerType: 'touch' },
      { type: 'pointercancel', pointerId: 2, pointerType: 'touch' },
    ])
    expect(emptied(state)).toEqual({ mode: 'idle', touches: 0, down: 0 })
  })

  it('a completed pan empties everything a gesture owns', () => {
    const { state } = run([down(1, { x: 100, y: 100 }), move(1, { x: 120, y: 120 }), up(1)])
    expect(emptied(state)).toEqual({ mode: 'idle', touches: 0, down: 0 })
  })

  it('keeps the press memory, which is the one thing that outlives a gesture', () => {
    const { state } = run([down(1, { x: 100, y: 100 }, { timeStamp: 7 }), up(1)])
    expect(NAVIGATION_MEMORY_KEYS).toEqual(['lastHandPress'])
    expect(state.lastHandPress).toEqual({ at: 7, point: { x: 100, y: 100 } })
  })
})
