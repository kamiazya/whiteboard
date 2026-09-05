// @vitest-environment node
/**
 * The navigation machine's behaviour, stated at the model level.
 *
 * These are a PORT's specification, not a discovery: every case here is
 * behaviour `SpatialEditor.tsx` already ships and its browser tests already
 * pin. Writing them at this layer is what makes the port checkable at all —
 * a reducer whose only evidence is "the browser suite still passes" would
 * tell you it broke without telling you where.
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
  DOUBLE_PRESS_WINDOW_MS,
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

  it('pans when the second press is late, however close in space', () => {
    const { effects, state } = run([
      first,
      up(1),
      down(1, { x: 100, y: 100 }, { timeStamp: DOUBLE_PRESS_WINDOW_MS + 1 }),
    ])
    expect(effects.filter((effect) => effect.kind === 'zoom-at')).toEqual([])
    expect(state.mode.kind).toBe('panning')
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

  it('is never armed in hand mode, where its teardown would strand a live pan', () => {
    const { effects } = run([down(1, { x: 10, y: 20 })])
    expect(effects.filter((effect) => effect.kind === 'arm-long-press')).toEqual([])
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
