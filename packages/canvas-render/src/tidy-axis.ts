/**
 * The coordinate vocabulary every tidy pass is written in.
 *
 * Each rule in `tidy.ts` is stated once and run twice, so each one used to
 * carry `axis === 'x' ? … : …` at every read of a position, every write of
 * one, and every pick of an origin or a floor — 18 of them, each a branch a
 * reader has to resolve before seeing what the rule says, and each the one
 * place a rule can be written asymmetrically by accident.
 *
 * It lives in its own module rather than beside the band pass it was
 * introduced for, because four passes read it: a contract filed under its
 * first consumer is one the others reach up to.
 */
import { type Rect, TIDY_GRID_PX, type Unit } from './tidy-units.js'

/**
 * The grid is laid from an ORIGIN, which inside a frame is the frame's own
 * corner rather than the board's zero.
 *
 * A frame is snapped to the board's grid like anything else, so it moves by
 * whatever it was off by — and every member placed against the board's grid
 * before that move is carried the same distance OFF it. The next tidy put
 * them back, which is what made tidy non-idempotent on any board holding a
 * frame drawn off the grid (2446 of 3000 generated boards). Laid from the
 * frame's corner instead, a member's position is a fact about the frame,
 * and moving the frame carries it and its grid together.
 *
 * The visible cost, stated because a reader will find it: a member of an
 * off-grid frame is off the BOARD's grid by the frame's own offset. That is
 * the frame's alignment to answer for, and it is answered — the frame
 * itself takes the board's grid — where a member 3px off the row inside its
 * own frame answers for nothing.
 */
export const roundToGrid = (v: number, origin = 0) =>
  origin + Math.round((v - origin) / TIDY_GRID_PX) * TIDY_GRID_PX
export const ceilToGrid = (v: number, origin = 0) =>
  origin + Math.ceil((v - origin) / TIDY_GRID_PX) * TIDY_GRID_PX

/**
 * An axis as a THING, rather than a string each site re-reads.
 *
 * `of` is what lets an axis pick its own component out of anything shaped
 * like a pair, which is what an origin, a floor and the outside anchors
 * all are.
 */
export interface Axis {
  /** The near edge: a rect's own x or y. */
  readonly near: (r: Rect) => number
  /** The extent along this axis: a rect's w or h. */
  readonly size: (r: Rect) => number
  /** The anchor at `fraction` of the extent — 0 near, 0.5 centre, 1 far. */
  readonly at: (r: Rect, fraction: number) => number
  /** This axis's component of an origin, a floor, or the outside anchors. */
  readonly of: <T>(pair: { readonly x: T; readonly y: T }) => T
  /** `r` as it would be `delta` along this axis, without moving `r`. */
  readonly moved: (r: Rect, delta: number) => Rect
  /** Move a unit, keeping its box and its accumulated delta in step. */
  readonly shift: (u: Unit, delta: number) => void
  /**
   * The anchors a drawer actually sets on this axis: the near edge, the
   * centre, and on x the far edge — a width is named, a height is usually
   * fitted to the text.
   */
  readonly bandFractions: readonly number[]
}

export const AXIS_X: Axis = {
  near: (r) => r.x,
  size: (r) => r.w,
  at: (r, fraction) => r.x + r.w * fraction,
  of: (pair) => pair.x,
  moved: (r, delta) => ({ ...r, x: r.x + delta }),
  shift: (u, delta) => {
    if (delta === 0) return
    u.bbox.x += delta
    u.dx += delta
  },
  bandFractions: [0, 0.5, 1],
}

export const AXIS_Y: Axis = {
  near: (r) => r.y,
  size: (r) => r.h,
  at: (r, fraction) => r.y + r.h * fraction,
  of: (pair) => pair.y,
  moved: (r, delta) => ({ ...r, y: r.y + delta }),
  shift: (u, delta) => {
    if (delta === 0) return
    u.bbox.y += delta
    u.dy += delta
  },
  bandFractions: [0, 0.5],
}

export const AXES: readonly Axis[] = [AXIS_X, AXIS_Y]

/** Whether `value` sits on one of `anchors`, to the half pixel parity allows. */
export const onSomeAnchor = (value: number, anchors: readonly number[]): boolean =>
  anchors.some((anchor) => Math.abs(anchor - value) <= 0.5)
