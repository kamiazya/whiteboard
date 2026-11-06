/**
 * The seams parameter says only what reaches the worker. Below the offload
 * threshold every option is spread into a synchronous layout; past it, only
 * what the `LayoutRequest` names survives the hop — so an option the request
 * does not carry would draw a small canvas one way and a large one another.
 */

import { expectTypeOf, it } from 'vitest'
import type { LayoutRequest } from '../../lib/layout-worker-protocol.js'
import type { useWorkerScene } from './use-worker-scene.js'

it('accepts no seam the worker request cannot carry, and no look override', () => {
  type Seams = Parameters<typeof useWorkerScene>[2]
  expectTypeOf<Seams>().not.toHaveProperty('commentObstacles')
  // The editor draws the theme the document names and nothing sets another
  // look, so neither the seams nor the request the worker answers carry one.
  expectTypeOf<Seams>().not.toHaveProperty('style')
  expectTypeOf<LayoutRequest>().not.toHaveProperty('style')
})
