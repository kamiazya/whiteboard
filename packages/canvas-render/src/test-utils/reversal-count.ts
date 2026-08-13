/**
 * Independent oracle for the `path-reversal` penalty rule: direction
 * reversals per axis along a polyline — a segment whose sign on an axis is
 * opposite to the last non-zero sign on that same axis. Deliberately never
 * calls production code, so a test asserting against it cannot be satisfied
 * by a broken rule agreeing with itself.
 */
export function referenceReversalCount(path: readonly { x: number; y: number }[]): number {
  let reversals = 0
  let lastSignX: number | undefined
  let lastSignY: number | undefined
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    const sx = Math.sign(b.x - a.x)
    const sy = Math.sign(b.y - a.y)
    if (sx !== 0) {
      if (lastSignX !== undefined && sx === -lastSignX) reversals++
      lastSignX = sx
    }
    if (sy !== 0) {
      if (lastSignY !== undefined && sy === -lastSignY) reversals++
      lastSignY = sy
    }
  }
  return reversals
}
