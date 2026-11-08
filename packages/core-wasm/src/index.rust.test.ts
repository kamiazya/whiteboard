import { readFileSync } from 'node:fs'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { abi_version, edge_route_layout, initSync } from '#glue'
import { loadCore } from './load.js'
import type { RoutingBudget } from './types.js'

/**
 * The shim over the artifact `stage:wasm` copied into artifacts/: it loads
 * from bytes and from a compiled module, agrees with the artifact on the
 * ABI, and calls nothing the artifact does not export. What it routes is
 * held to the TypeScript composer by canvas-render's route-layout
 * differential, which goes through this shim.
 */

// Built, not committed: a name the relative-import scan reads as a file that
// must exist would fail every job that has no wasm build.
const WASM = 'whiteboard_wasm_bg.wasm'
const bytes = () => readFileSync(new URL(`../artifacts/${WASM}`, import.meta.url))
const box = (id: string, x: number): SpatialNode =>
  ({ id, type: 'text', text: '', x, y: 0, width: 100, height: 50 }) as SpatialNode
const budget = (): RoutingBudget => ({ grid: 1e6, pairs: 1e6, trials: 1e6, repairs: 1e6 })

describe('the core-wasm shim over the built artifact', () => {
  it('declares only exports the artifact has', () => {
    expect([typeof initSync, typeof abi_version, typeof edge_route_layout]).toEqual([
      'function',
      'function',
      'function',
    ])
  })

  it('routes a layout from the bytes, and again from a compiled module', async () => {
    for (const source of [bytes(), new WebAssembly.Module(bytes())]) {
      const core = await loadCore(source)
      const b = budget()
      const { routes, anchors } = core.routeLayout(
        [box('a', 0), box('b', 300)],
        [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
        () => 'orthogonal',
        undefined,
        b,
        [],
      )
      const [route] = routes
      expect(route?.path.at(0)?.x).toBe(100)
      expect(route?.path.at(-1)?.x).toBe(300)
      expect(route?.fromSide).toBe('right')
      expect(route?.toSide).toBe('left')
      expect(anchors.get('e')).toMatchObject({ fromSide: 'right', toSide: 'left' })
      // A clean pair needs no trial: the search short-circuits.
      expect(b).toEqual(budget())
    }
  })
})
