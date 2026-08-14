/**
 * Independent oracle for the `path-reversal` penalty rule: direction
 * reversals per axis along a polyline — a segment whose sign on an axis is
 * opposite to the last non-zero sign on that same axis. Deliberately never
 * calls production code, so a test asserting against it cannot be satisfied
 * by a broken rule agreeing with itself.
 *
 * Compares RAW coordinates, where the rule compares them quantized by
 * COST_QUANTUM. The two agree only while every per-axis step is either zero
 * or at least one quantum, so callers supply integer or quantum-separated
 * geometry — `assertQuantumSeparated` states that contract for a caller
 * feeding it real routed paths, whose anchors are fractional.
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

/**
 * Guards the oracle's stated domain for a caller that feeds it real routed
 * geometry. Without it, a future route carrying a sub-quantum wobble would
 * fail the comparison as if the RULE were wrong, which is the most expensive
 * kind of red: a correct implementation accused by its own oracle.
 */
export function assertQuantumSeparated(
  path: readonly { x: number; y: number }[],
  quantum: number,
): void {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    for (const step of [Math.abs(b.x - a.x), Math.abs(b.y - a.y)]) {
      if (step !== 0 && step < quantum) {
        throw new Error(
          `path step ${step} is below one quantum (${quantum}); the raw-coordinate oracle does not model this path`,
        )
      }
    }
  }
}
