import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { DETOUR_REACH_PX, detourCandidates } from './spatial-edges.js'

/**
 * `routeOrthogonal` prunes its obstacle set to the box a candidate path can
 * reach, which is what keeps it from testing every node on the canvas six to
 * fifteen times per edge. That prune is only sound while detour waypoints
 * stay inside the bound it assumes.
 *
 * They did not, once: the waypoints sit `OBSTACLE_CLEARANCE_PX` OUTSIDE the
 * region, and the first version of the prune stopped at the region itself, so
 * an obstacle in that 16px band was dropped and routes changed. The routing
 * scoreboard caught it — but as "these numbers moved", which is a long way
 * from "the pruning bound is too small". This pins the bound directly, so a
 * later change to where a detour is placed fails HERE, next to the constant
 * that has to move with it.
 */
const finite = (min: number, max: number) => fc.integer({ min, max })

describe('detour waypoints stay inside the bound the obstacle prune assumes', () => {
  fcTest.prop(
    {
      start: fc.record({ x: finite(-500, 500), y: finite(-500, 500) }),
      end: fc.record({ x: finite(-500, 500), y: finite(-500, 500) }),
      region: fc.record({
        x: finite(-400, 400),
        y: finite(-400, 400),
        w: finite(0, 600),
        h: finite(0, 600),
      }),
    },
    withDefaults({ numRuns: 300 }),
  )(
    'every point lies within the endpoints and the region grown by DETOUR_REACH_PX',
    ({ start, end, region }) => {
      const minX = Math.min(start.x, end.x, region.x - DETOUR_REACH_PX)
      const maxX = Math.max(start.x, end.x, region.x + region.w + DETOUR_REACH_PX)
      const minY = Math.min(start.y, end.y, region.y - DETOUR_REACH_PX)
      const maxY = Math.max(start.y, end.y, region.y + region.h + DETOUR_REACH_PX)
      for (const path of detourCandidates(start, end, region)) {
        for (const point of path) {
          expect(point.x).toBeGreaterThanOrEqual(minX)
          expect(point.x).toBeLessThanOrEqual(maxX)
          expect(point.y).toBeGreaterThanOrEqual(minY)
          expect(point.y).toBeLessThanOrEqual(maxY)
        }
      }
    },
  )
})
