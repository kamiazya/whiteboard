/**
 * Align and distribute geometry for a multi-node selection.
 *
 * Pure and total by construction: every entry point returns a (possibly
 * empty) list of moves and never throws, so one degenerate selection can
 * never abort an editor gesture. Both functions report ONLY the boxes that
 * actually move — an already-aligned selection produces an empty list, which
 * is what keeps a no-op action out of the undo history.
 *
 * Coordinates are rounded here rather than left to `applyCommand`'s own
 * rounding, so the no-op filter compares the value that will actually be
 * stored.
 */

export interface AlignableBox {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BoxMove {
  readonly id: string
  readonly x: number
  readonly y: number
}

export type AlignMode = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

/** Drops anything the canvas schema would never produce, so the maths below
 *  can assume finite numbers without guarding at every step. */
function usable(boxes: readonly AlignableBox[]): AlignableBox[] {
  return boxes.filter(
    (box) =>
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height),
  )
}

function moved(box: AlignableBox, x: number, y: number): BoxMove | null {
  const nextX = Math.round(x)
  const nextY = Math.round(y)
  if (nextX === box.x && nextY === box.y) return null
  return { id: box.id, x: nextX, y: nextY }
}

/**
 * Aligns every box to one edge (or centre line) of the selection's own
 * bounding box. The bounding box — not the primary selection — is the
 * reference, so the result does not depend on which node was clicked first.
 */
export function alignBoxes(boxes: readonly AlignableBox[], mode: AlignMode): readonly BoxMove[] {
  const usableBoxes = usable(boxes)
  if (usableBoxes.length < 2) return []

  const left = Math.min(...usableBoxes.map((box) => box.x))
  const right = Math.max(...usableBoxes.map((box) => box.x + box.width))
  const top = Math.min(...usableBoxes.map((box) => box.y))
  const bottom = Math.max(...usableBoxes.map((box) => box.y + box.height))

  const moves: BoxMove[] = []
  for (const box of usableBoxes) {
    let { x, y } = box
    switch (mode) {
      case 'left':
        x = left
        break
      case 'right':
        x = right - box.width
        break
      case 'center-x':
        x = (left + right) / 2 - box.width / 2
        break
      case 'top':
        y = top
        break
      case 'bottom':
        y = bottom - box.height
        break
      case 'center-y':
        y = (top + bottom) / 2 - box.height / 2
        break
    }
    const move = moved(box, x, y)
    if (move !== null) moves.push(move)
  }
  return moves
}

/**
 * Spreads the boxes so the GAPS between them are equal — the behaviour a
 * single "distribute" action is expected to have, and the one that stays
 * sensible when the boxes are different sizes (equalising centres instead
 * would leave visibly uneven gaps around a wide box).
 *
 * The two outermost boxes anchor the span and never move. A selection whose
 * widths exceed that span yields a negative gap: the boxes overlap evenly
 * rather than the function bailing, which keeps it total.
 */
export function distributeBoxes(
  boxes: readonly AlignableBox[],
  axis: DistributeAxis,
): readonly BoxMove[] {
  const usableBoxes = usable(boxes)
  // Two boxes are already "evenly spaced" by definition, so there is
  // nothing to distribute until there is a middle.
  if (usableBoxes.length < 3) return []

  const horizontal = axis === 'horizontal'
  const start = (box: AlignableBox) => (horizontal ? box.x : box.y)
  const extent = (box: AlignableBox) => (horizontal ? box.width : box.height)

  const ordered = [...usableBoxes].sort((a, b) => start(a) - start(b))
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const span = start(last) + extent(last) - start(first)
  const totalExtent = ordered.reduce((sum, box) => sum + extent(box), 0)
  const gap = (span - totalExtent) / (ordered.length - 1)

  const moves: BoxMove[] = []
  let cursor = start(first) + extent(first) + gap
  // Endpoints anchor the span; only the middle boxes are repositioned.
  for (const box of ordered.slice(1, -1)) {
    const move = horizontal ? moved(box, cursor, box.y) : moved(box, box.x, cursor)
    if (move !== null) moves.push(move)
    cursor += extent(box) + gap
  }
  return moves
}
