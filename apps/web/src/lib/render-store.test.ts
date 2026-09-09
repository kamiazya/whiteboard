// The store's WORTH-IT gate, tested where the decision lives.
//
// It used to be asserted through a real render in a browser — lay out three
// nodes, then claim nothing was written — which made the test's premise "this
// machine lays out three nodes in under 5ms". A test cannot establish that,
// and a loaded CI runner makes it false, at which point the production code
// stores the render BECAUSE THAT IS WHAT IT IS FOR and the failure names the
// gate rather than the clock. The claim is machine-independent only when it is
// stated about the decision, so that is where it is stated.

import { describe, expect, it } from 'vitest'
import { STORE_FLOOR_MS, worthStoring } from './render-store.js'

const source = import.meta.glob('./layout-worker.ts', { query: '?raw', import: 'default' })

describe('worthStoring', () => {
  it('keeps a render that cost more than the write it would pay for', () => {
    expect(worthStoring(STORE_FLOOR_MS)).toBe(true)
    expect(worthStoring(STORE_FLOOR_MS + 1)).toBe(true)
    expect(worthStoring(67.2)).toBe(true)
  })

  it('refuses one below the floor, where the write costs more than it saves', () => {
    expect(worthStoring(STORE_FLOOR_MS - 0.001)).toBe(false)
    expect(worthStoring(2)).toBe(false)
    expect(worthStoring(0)).toBe(false)
  })

  // A clock that answers nonsense must not become a store that fills up: the
  // comparison would be false either way, and saying so here is what stops a
  // later `!(elapsed < FLOOR)` rewrite from silently inverting it.
  it('refuses a measurement that is not a finite duration', () => {
    expect(worthStoring(Number.NaN)).toBe(false)
    expect(worthStoring(Number.POSITIVE_INFINITY)).toBe(false)
    expect(worthStoring(-1)).toBe(false)
  })
})

// Tier-2 conformance, the shape `canvas-viewer-geometry-conformance.test.ts`
// uses: the unit test above proves the gate, and this proves the worker is
// the caller. Without it the worker could keep a floor of its own and the
// two could drift — which is the state this change found.
describe('the layout worker gates through the shared floor', () => {
  it('calls worthStoring and declares no floor of its own', async () => {
    const loader = source['./layout-worker.ts']
    const text = (await loader?.()) as string
    expect(text).toContain('worthStoring(')
    expect(text).not.toMatch(/const\s+STORE_FLOOR_MS/)
  })
})
