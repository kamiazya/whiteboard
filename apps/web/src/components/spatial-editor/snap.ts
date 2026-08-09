/**
 * Snapping geometry for a dragged box.
 *
 * Pure and total, like `align.ts`: it takes the box's would-be position and
 * returns the position to actually use plus the guide lines that justify it.
 * Nothing here reads the DOM, the viewport, or a modifier key — the caller
 * decides whether snapping is on and what the threshold is in canvas units.
 *
 * The two axes snap INDEPENDENTLY. A box can land on another node's left
 * edge horizontally while snapping to the grid vertically, which is what
 * every comparable editor does and what makes near-misses feel forgiving
 * rather than all-or-nothing.
 *
 * Node candidates beat grid candidates at equal distance: a deliberate
 * alignment to real content is more likely what the user meant than an
 * invisible lattice, and the grid is dense enough that it would otherwise
 * win most ties. That falls out of building node candidates first and
 * accepting only a STRICTLY closer replacement — see `best`.
 */

export interface SnapBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface SnapOptions {
  /** Max distance, in CANVAS units, at which a candidate attracts. */
  readonly thresholdCanvasPx: number
  /** Grid pitch in canvas units; 0 or non-finite disables grid snapping. */
  readonly gridSize: number
}

export interface SnapResult {
  readonly x: number
  readonly y: number
  /** Canvas-space x positions of the vertical guides to draw (may be empty). */
  readonly guidesX: readonly number[]
  /** Canvas-space y positions of the horizontal guides to draw. */
  readonly guidesY: readonly number[]
}

/** A candidate line the moving box can be attracted to, on one axis. */
interface Candidate {
  /** Where the moving box's ORIGIN lands if this candidate wins. */
  readonly origin: number
  /** Distance from the un-snapped origin — smaller wins. */
  readonly distance: number
  /** The line to draw; absent for grid candidates, which have no content. */
  readonly guide: number | undefined
}

function finiteBox(box: SnapBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  )
}

/**
 * Builds every candidate for ONE axis. `start`/`extent` project the axis, so
 * the same logic serves x/width and y/height without a second copy that
 * could drift.
 */
function candidatesForAxis(
  start: number,
  movingOffsets: readonly number[],
  others: readonly SnapBox[],
  options: SnapOptions,
  pick: (box: SnapBox) => { start: number; extent: number },
): Candidate[] {
  const candidates: Candidate[] = []

  for (const other of others) {
    if (!finiteBox(other)) continue
    const projected = pick(other)
    const otherLines = [
      projected.start,
      projected.start + projected.extent / 2,
      projected.start + projected.extent,
    ]
    for (const line of otherLines) {
      for (const offset of movingOffsets) {
        const origin = line - offset
        candidates.push({
          origin,
          distance: Math.abs(origin - start),
          guide: line,
        })
      }
    }
  }

  if (Number.isFinite(options.gridSize) && options.gridSize > 0) {
    // Only the leading edge snaps to the grid. Snapping centre and trailing
    // edge too would triple the lattice's pull for no extra expressiveness,
    // and would fight the node candidates the user actually aimed at.
    const snapped = Math.round(start / options.gridSize) * options.gridSize
    candidates.push({
      origin: snapped,
      distance: Math.abs(snapped - start),
      guide: undefined,
    })
  }

  return candidates
}

function best(candidates: readonly Candidate[], threshold: number): Candidate | undefined {
  let winner: Candidate | undefined
  for (const candidate of candidates) {
    if (candidate.distance > threshold) continue
    if (winner === undefined) {
      winner = candidate
      continue
    }
    // Strictly closer only, so an equal-distance later candidate never
    // displaces an earlier one. Node candidates are built before the grid
    // candidate (see candidatesForAxis), which is what makes content win a
    // tie — an explicit tie-break branch here would be unreachable, and
    // unreachable code rots. The "prefers a node over the grid at equal
    // distance" test pins the outcome, so reordering the two would fail.
    if (candidate.distance < winner.distance) winner = candidate
  }
  return winner
}

/**
 * Returns where the dragged box should actually land, plus the guides that
 * explain it. A box with nothing in range comes back unchanged with no
 * guides, so a caller can always use the result unconditionally.
 */
export function snapBox(
  moving: SnapBox,
  others: readonly SnapBox[],
  options: SnapOptions,
): SnapResult {
  const noSnap: SnapResult = { x: moving.x, y: moving.y, guidesX: [], guidesY: [] }
  if (!finiteBox(moving)) return noSnap
  if (!Number.isFinite(options.thresholdCanvasPx) || options.thresholdCanvasPx < 0) return noSnap

  // A moving box offers three lines of its own — leading edge, centre and
  // trailing edge. Matching centre-to-centre and edge-to-edge is what makes
  // differently-sized boxes line up the way they look aligned.
  const xWinner = best(
    candidatesForAxis(moving.x, [0, moving.width / 2, moving.width], others, options, (box) => ({
      start: box.x,
      extent: box.width,
    })),
    options.thresholdCanvasPx,
  )
  const yWinner = best(
    candidatesForAxis(moving.y, [0, moving.height / 2, moving.height], others, options, (box) => ({
      start: box.y,
      extent: box.height,
    })),
    options.thresholdCanvasPx,
  )

  return {
    x: xWinner?.origin ?? moving.x,
    y: yWinner?.origin ?? moving.y,
    guidesX: xWinner?.guide === undefined ? [] : [xWinner.guide],
    guidesY: yWinner?.guide === undefined ? [] : [yWinner.guide],
  }
}

/**
 * Snaps ONE dragged edge, for a resize.
 *
 * A resize moves an edge, not a whole box, so the edge is the only line the
 * gesture offers — passing the move candidates here would let the box's own
 * centre or far edge pull the handle, which reads as the handle fighting the
 * pointer. That difference is why this is a separate entry point rather than
 * `snapBox` with a zero-size box.
 *
 * The candidates it can land on are the same as for a move (a neighbour's
 * leading edge, centre, or trailing edge, plus the grid), so a resized edge
 * lines up with content the same way a moved one does.
 */
export function snapEdge(
  position: number,
  others: readonly SnapBox[],
  options: SnapOptions,
  axis: 'x' | 'y',
): { position: number; guide: number | undefined } {
  const unchanged = { position, guide: undefined }
  if (!Number.isFinite(position)) return unchanged
  if (!Number.isFinite(options.thresholdCanvasPx) || options.thresholdCanvasPx < 0) return unchanged

  const winner = best(
    candidatesForAxis(position, [0], others, options, (box) =>
      axis === 'x' ? { start: box.x, extent: box.width } : { start: box.y, extent: box.height },
    ),
    options.thresholdCanvasPx,
  )
  return winner === undefined ? unchanged : { position: winner.origin, guide: winner.guide }
}
