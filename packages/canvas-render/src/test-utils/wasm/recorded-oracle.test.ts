import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { testLayoutCore } from '../test-layout-core.js'
import { encodeRecording, recordedDraws, routeLayoutCase } from './route-layout-oracle.js'

/**
 * The committed recording of the routing answers, replayed through the core
 * every root loads. The recording was taken from the TypeScript router while
 * it existed and is frozen since its deletion (ADR-0054 step 7, S18h3b; D13).
 * The Rust crate replays it natively (`crates/bindings/wasm/tests/recorded_oracle.rs`)
 * so cargo-mutants can judge its mutants by it; this replay regenerates the
 * same draws and asks `@kamiazya/whiteboard-core-wasm`'s typed `routeLayout`,
 * so the wire that shim encodes and the answer it decodes are held to the
 * recording too, byte for byte.
 *
 * Nothing re-records it: a deliberate routing change is a change to the
 * recording, made and reviewed as one.
 */
// Kept here, not beside the Rust test: this tree is in the Rust jobs' path
// scope, so a change to the recording runs both sides, while a crate change
// does not run this package's projects (affected.mjs reads a path a source names).
const FILE = new URL('./oracle/route_layout.f64', import.meta.url)

describe('the recorded routing oracle', () => {
  const core = testLayoutCore().routing
  const cases = recordedDraws().map(({ draw, grid }) => routeLayoutCase(core, draw, grid))
  const bytes = encodeRecording(cases)

  it('holds the corpus and the generated draws, and reaches what the router branches on', () => {
    expect(cases.length).toBeGreaterThan(300)
    const bent = cases.filter((c) => c.routed.some((r) => r.path.length > 2)).length
    const cut = cases.filter((c) => c.budget.grid === 0 || c.budget.trials === 0).length
    expect(bent, 'layouts with a bent route').toBeGreaterThan(50)
    expect(cut, 'layouts that run an account dry').toBeGreaterThan(5)
  })

  it('equals what the core answers through the shim today', () => {
    const committed = new Uint8Array(readFileSync(FILE))
    expect(committed.length).toBe(bytes.length)
    const at = committed.findIndex((b, i) => b !== bytes[i])
    expect(at, 'the first byte the recording parts from the core at').toBe(-1)
  })
})
