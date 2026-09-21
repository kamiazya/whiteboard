/**
 * Banded alignment: the pass that puts what a drawer nearly lined up onto
 * one line.
 *
 * Per axis and per anchor a drawer sets — the near edge, then the centre,
 * then on x the far edge — units whose anchors sit within `TIDY_BAND_PX` of
 * the band's FIRST member snap to one target. Banding by that fixed first
 * anchor, never a running mean, is what stops transitive chaining (A near B,
 * C near B's new spot) from dragging a whole diagonal into one line.
 */
import { type Axis, roundToGrid } from './tidy-axis.js'
import { overlapsWithMargin, TIDY_BAND_PX, type Unit } from './tidy-units.js'

/**
 * The two things a snap may not buy alignment with. Both are refusals, so
 * neither ever moves anything, and they are bundled because every site that
 * asks one asks the other.
 */
interface SnapGuard {
  /**
   * Separation. A centre or far-edge snap is cosmetic and separation is
   * not, so one that would put a unit inside a neighbour's margin yields.
   * Without this the fixpoint loop drifts: the snap jams the unit, the
   * overlap pass hops it away, and the next iteration snaps it back — an
   * edge band can never do that, since a hop carries a unit out of its own
   * band's reach, but a band measured against a third unit can.
   */
  readonly clearAfter: (unit: Unit, delta: number) => boolean
  /**
   * The frame's margin. Inside a frame, a band may not push a unit back OUT
   * past it.
   *
   * The floor runs once, before these passes, so without this a band undoes
   * it — and that is not merely cosmetic, it is what made tidy grow a frame
   * for ever. Measured: a far-edge band snapped one member's left edge to
   * the grid, dragged its row-mate 3px left of the margin, the frame grew to
   * hold the escapee, and the level's own snap then carried the whole unit
   * back — 3px wider on every tidy, with no member moving at all.
   *
   * Applying the floor again AFTER the passes was tried instead and is worse
   * than the bug: the overlap pass no longer gets the last word, and the
   * grouped corpus went from 0 overlapping pairs to 109.
   */
  readonly insideMargin: (unit: Unit, delta: number) => boolean
}

export function snapGuardFor(
  units: readonly Unit[],
  ax: Axis,
  floor: number | undefined,
): SnapGuard {
  return {
    clearAfter: (unit, delta) => {
      const moved = ax.moved(unit.bbox, delta)
      return units.every((other) => other === unit || !overlapsWithMargin(moved, other.bbox))
    },
    insideMargin: (unit, delta) => floor === undefined || ax.near(unit.bbox) + delta >= floor - 0.5,
  }
}

/**
 * Record who ended up sharing `target`.
 *
 * Lined up means sharing the anchor with SOMETHING, to the half pixel
 * parity allows: a band whose every other snap yielded leaves its first
 * member alone, and alone it takes the grid like any other.
 */
function recordLinedUp(
  band: readonly Unit[],
  anchor: (u: Unit) => number,
  target: number,
  lined: Set<Unit>,
): void {
  const atTarget = band.filter((u) => Math.abs(anchor(u) - target) <= 0.5)
  if (atTarget.length >= 2) for (const unit of atTarget) lined.add(unit)
}

/** Put `unit`'s near edge on the grid, if both guards allow it. */
function groundOnGrid(
  unit: Unit,
  ax: Axis,
  origin: number,
  guarded: boolean,
  guard: SnapGuard,
): void {
  const at = ax.near(unit.bbox)
  const toGrid = roundToGrid(at, origin) - at
  if (guarded && !guard.clearAfter(unit, toGrid)) return
  if (!guard.insideMargin(unit, toGrid)) return
  ax.shift(unit, toGrid)
}

/**
 * Snap one band onto one target, and record who ended up sharing it.
 *
 * `fraction` is both which anchor this is and whether the snap is GUARDED:
 * the near edge is the row itself and takes its snap, a centre or far edge
 * is cosmetic and yields to the guard.
 */
function snapBand(
  band: readonly Unit[],
  ax: Axis,
  fraction: number,
  origin: number,
  guard: SnapGuard,
  lined: Set<Unit>,
): void {
  const anchor = (u: Unit) => ax.at(u.bbox, fraction)
  const edge = (u: Unit) => ax.near(u.bbox)
  const guarded = fraction !== 0
  // An immobile member is the band's truth, and so is one an earlier anchor
  // lined up: a movable one snaps onto it exactly, grid or no grid, since
  // the grid cannot move that neighbour and a 4px miss reads as a row drawn
  // carelessly. A band free to move as a whole puts its first member's edge
  // on the grid and follows it.
  const fixed = band.find((u) => !u.movable || lined.has(u))
  const first = band[0] as Unit
  // A partner inside a neighbour's margin is about to be hopped away by the
  // overlap pass, and a unit lined up to it this iteration would be left off
  // the grid, lined up with nothing. So a centre or far-edge band follows
  // only a partner that is standing still.
  const partner = fixed ?? first
  if (guarded && !guard.clearAfter(partner, 0)) return
  // A band free to move as a whole is its own truth, so it puts that truth
  // on the grid before the rest follow it there.
  if (fixed === undefined) groundOnGrid(first, ax, origin, guarded, guard)
  const target = anchor(partner)
  for (const unit of band) {
    if (!unit.movable || lined.has(unit)) continue
    // A centre between a box of each parity is a half pixel; the edge takes
    // the whole pixel nearest, since the output is rounded and a snap the
    // rounding undoes is not a snap.
    const delta = Math.round(edge(unit) + target - anchor(unit)) - edge(unit)
    if (guarded && delta !== 0 && !guard.clearAfter(unit, delta)) continue
    if (!guard.insideMargin(unit, delta)) continue
    ax.shift(unit, delta)
  }
  recordLinedUp(band, anchor, target, lined)
}

/**
 * Banded alignment along one axis. A unit lined up by an earlier anchor is
 * that band's truth for the later ones and does not move again; a unit
 * alone at its edge may still be centred under a wider neighbour, which a
 * reader calls lined up and an edge band could never see.
 */
export function alignBands(units: Unit[], ax: Axis, origin: number, floor?: number): void {
  const guard = snapGuardFor(units, ax, floor)
  const lined = new Set<Unit>()
  for (const fraction of ax.bandFractions) {
    for (const band of bandsBy(units, (u) => ax.at(u.bbox, fraction))) {
      if (band.length >= 2) snapBand(band, ax, fraction, origin, guard, lined)
    }
  }
  // A unit in no band at all takes the grid at its edge. Unguarded: an edge
  // snap is the row itself, not a cosmetic one, so only the margin refuses.
  for (const unit of units) {
    if (unit.movable && !lined.has(unit)) groundOnGrid(unit, ax, origin, false, guard)
  }
}

/**
 * Bands by the fixed first anchor — never a running mean — which is what
 * stops transitive chaining (A near B, C near B's new spot) from dragging a
 * whole diagonal into one line. STRICT inequality: consecutive band targets
 * are >= one band apart (multiples of the grid), so a snapped unit sitting
 * exactly one band from a neighbour must not re-join it on a later pass.
 */
function bandsBy(units: Unit[], anchor: (u: Unit) => number): Unit[][] {
  const sorted = [...units].sort((a, b) => anchor(a) - anchor(b))
  const bands: Unit[][] = []
  let band: Unit[] = []
  let bandFirst = 0
  for (const unit of sorted) {
    if (band.length === 0 || anchor(unit) - bandFirst >= TIDY_BAND_PX) {
      if (band.length > 0) bands.push(band)
      band = []
      bandFirst = anchor(unit)
    }
    band.push(unit)
  }
  if (band.length > 0) bands.push(band)
  return bands
}
