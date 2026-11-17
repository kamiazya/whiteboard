import { fc } from '../fast-check.js'

/**
 * The draws the routing arbitraries (`routing-arbitraries.ts`,
 * `search-arbitraries.ts`) build boards from, and so what the frozen routing
 * recording's generated half was sampled from (ADR-0054 step 5, QR-21). The
 * differentials that shared them went with the TypeScript router (step 7,
 * S18h3b).
 */

/**
 * Coordinates mostly on a 2.5px lattice, so paths run along each other and
 * along borders (where the ink terms are non-zero), sometimes on an
 * eighth-pixel one, which lands on the half quanta `quantize` rounds, plus
 * the doubles JavaScript treats specially.
 */
export const coordinate = fc.oneof(
  { weight: 10, arbitrary: fc.integer({ min: -40, max: 80 }).map((k) => k * 2.5) },
  { weight: 2, arbitrary: fc.integer({ min: -400, max: 800 }).map((k) => k / 8) },
  { weight: 1, arbitrary: fc.double({ min: -200, max: 200 }) },
  { weight: 1, arbitrary: fc.constantFrom(-0, Number.NaN, Number.POSITIVE_INFINITY, -1e300) },
)
const size = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 24 }).map((k) => k * 2.5) },
  { weight: 1, arbitrary: fc.constantFrom(0, -0, -10, Number.NaN) },
)
export const point = fc.record({ x: coordinate, y: coordinate })
export const rect = fc.record({ x: coordinate, y: coordinate, w: size, h: size })
