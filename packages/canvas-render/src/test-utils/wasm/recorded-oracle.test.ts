import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeRecording, recordedDraws, routeLayoutCase } from './route-layout-oracle.js'

/**
 * The committed recording of the TypeScript's routing answers equals what
 * the TypeScript answers today, byte for byte. The Rust crate replays that
 * recording natively (`crates/bindings/wasm/tests/recorded_oracle.rs`) so
 * cargo-mutants can judge its mutants by it; a recording left behind a
 * TypeScript change would judge them against an answer nobody gives.
 *
 * In this project no alias replaces `edge-router`, `spatial-edges` or
 * `grid-route`, so the answers are the TypeScript's own.
 *
 * Re-record after a deliberate routing change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node recorded-oracle`.
 */
// Kept here, not beside the Rust test: this tree is in the Rust jobs' path
// scope, so a re-recording runs both sides, while a crate change does not
// run this package's projects (affected.mjs reads a path a source names).
const FILE = new URL('./oracle/route_layout.f64', import.meta.url)

describe('the recorded routing oracle', () => {
  const cases = recordedDraws().map(({ draw, grid }) => routeLayoutCase(draw, grid))
  const bytes = encodeRecording(cases)

  it('holds the corpus and the generated draws, and reaches what the router branches on', () => {
    expect(cases.length).toBeGreaterThan(300)
    const bent = cases.filter((c) => c.routed.some((r) => r.path.length > 2)).length
    const cut = cases.filter((c) => c.budget.grid === 0 || c.budget.trials === 0).length
    expect(bent, 'layouts with a bent route').toBeGreaterThan(50)
    expect(cut, 'layouts that run an account dry').toBeGreaterThan(5)
  })

  it('equals what the TypeScript answers today', () => {
    if (process.env.WHITEBOARD_RECORD_ORACLE === '1') writeFileSync(FILE, bytes)
    const committed = new Uint8Array(readFileSync(FILE))
    expect(committed.length).toBe(bytes.length)
    const at = committed.findIndex((b, i) => b !== bytes[i])
    expect(at, 'the first byte the recording parts from the TypeScript at').toBe(-1)
  })
})
