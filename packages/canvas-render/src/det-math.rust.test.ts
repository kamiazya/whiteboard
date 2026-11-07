import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { cos, hypot, sin } from './det-math.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

/**
 * det-math.ts against the Rust `whiteboard-det` it is the oracle for, run
 * through the wasm artifact (ADR-0054, QR-21 layer 2). The two share nothing
 * but the inputs fast-check draws: neither side's answer is computed from
 * the other's code, and every comparison is exact.
 *
 * The exports are batched (one boundary call per run), so each property
 * draws an ARRAY of inputs and compares element-wise.
 */

/** What this test reads of the wasm-bindgen glue, declared rather than imported: the glue is a build output. */
interface WasmGlue {
  initSync(input: { module: BufferSource }): unknown
  abi_version(): string
  det_hypot(dx: Float64Array, dy: Float64Array): Float64Array
  det_sin(xs: Float64Array): Float64Array
  det_cos(xs: Float64Array): Float64Array
}

/** The surface this test was written against; a stale artifact fails here, not on its first mismatched call. */
const EXPECTED_ABI = '2'

const dir = process.env.WHITEBOARD_WASM_DIR ?? ''
const gluePath = join(dir, 'whiteboard_wasm.js')
const built = dir !== '' && existsSync(gluePath)

async function loadGlue(): Promise<WasmGlue> {
  const glue = (await import(pathToFileURL(gluePath).href)) as WasmGlue
  glue.initSync({ module: readFileSync(join(dir, 'whiteboard_wasm_bg.wasm')) })
  return glue
}

const wasm = built ? await loadGlue() : undefined

/**
 * Equal as IEEE 754 bits, except that any NaN equals any NaN: JavaScript does
 * not preserve a NaN's payload across a typed-array write, so a payload is
 * not something either side can promise. A signed zero still counts.
 */
function sameDouble(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b)
  return Object.is(a, b)
}

/** The first index where the two answers differ, with both values, for a minimal repro. */
function firstDifference(
  inputs: readonly number[],
  ts: readonly number[],
  rust: Float64Array,
): { input: number; ts: number; rust: number } | undefined {
  const at = ts.findIndex((value, i) => !sameDouble(value, rust[i] ?? Number.NaN))
  if (at === -1 && rust.length === ts.length) return undefined
  const i = at === -1 ? ts.length : at
  return { input: inputs[i] ?? Number.NaN, ts: ts[i] ?? Number.NaN, rust: rust[i] ?? Number.NaN }
}

// The first magnitude det-math.ts answers NaN for: the double whose high word
// is 0x413921fb, just under 2^20 * pi/2.
const REDUCTION_CEILING = 1647099

/**
 * Doubles from every region the two implementations branch on: the whole
 * line (NaN, infinities, subnormals, the extremes), the medium reduction's
 * range around its ceiling, and the first few turns where the kernels and
 * the near-multiple reductions sit.
 */
/** `x` moved `step` doubles toward positive infinity (a positive `x` only). */
function nudge(x: number, step: number): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  view.setBigUint64(0, view.getBigUint64(0) + BigInt(step))
  return view.getFloat64(0)
}

const angle = fc.oneof(
  fc.double(),
  fc.double({ min: -2e6, max: 2e6 }),
  fc.double({ min: -30, max: 30 }),
  // fast-check's doubles lean toward small magnitudes, so the medium
  // reduction's range is drawn on its own, by magnitude and sign.
  fc
    .tuple(fc.double({ min: Math.PI / 4, max: REDUCTION_CEILING, noNaN: true }), fc.boolean())
    .map(([magnitude, negative]) => (negative ? -magnitude : magnitude)),
  fc.double({ min: REDUCTION_CEILING * 0.999_999, max: REDUCTION_CEILING * 1.000_001 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0),
  // The reductions special-case the exact multiples of pi/4 and pi/2 by their
  // high word, which no uniform draw lands on: each multiple and the doubles
  // either side of it, signed.
  fc
    .tuple(fc.integer({ min: 1, max: 32 }), fc.integer({ min: -1, max: 1 }), fc.boolean())
    .map(([k, step, negative]) => {
      const x = nudge((k * Math.PI) / 4, step)
      return negative ? -x : x
    }),
)
const angles = fc.array(angle, { minLength: 1, maxLength: 64 })

const reach = { pastCeiling: 0, reduced: 0, kernel: 0, nonFinite: 0 }
function classify(x: number): void {
  const magnitude = Math.abs(x)
  if (!Number.isFinite(x)) reach.nonFinite += 1
  else if (magnitude >= REDUCTION_CEILING) reach.pastCeiling += 1
  else if (magnitude > Math.PI / 4) reach.reduced += 1
  else reach.kernel += 1
}

describe('the wasm artifact this differential runs against', () => {
  // A skip is probed, and impossible on CI: the `rust` job builds the
  // artifact before running this project, so its absence there is a broken
  // job, not a reason to pass.
  it.runIf(process.env.CI)('is built on CI', () => {
    expect(built, `no wasm artifact at ${gluePath}; run \`pnpm rust:build:wasm\``).toBe(true)
  })

  it.runIf(built)('speaks the ABI this test was written against', () => {
    expect(wasm?.abi_version()).toBe(EXPECTED_ABI)
  })
})

describe.runIf(built)('det-math.ts and whiteboard-det answer the same doubles', () => {
  fcTest.prop([angles], withDefaults())('sin', (xs) => {
    xs.forEach(classify)
    expect(
      firstDifference(xs, xs.map(sin), wasm?.det_sin(Float64Array.from(xs)) ?? new Float64Array()),
    ).toBeUndefined()
  })

  fcTest.prop([angles], withDefaults())('cos', (xs) => {
    expect(
      firstDifference(xs, xs.map(cos), wasm?.det_cos(Float64Array.from(xs)) ?? new Float64Array()),
    ).toBeUndefined()
  })

  fcTest.prop(
    [fc.array(fc.tuple(fc.double(), fc.double()), { minLength: 1, maxLength: 64 })],
    withDefaults(),
  )('hypot', (pairs) => {
    const dx = Float64Array.from(pairs, ([x]) => x)
    const dy = Float64Array.from(pairs, ([, y]) => y)
    const ts = pairs.map(([x, y]) => hypot(x, y))
    expect(
      firstDifference([...dx], ts, wasm?.det_hypot(dx, dy) ?? new Float64Array()),
    ).toBeUndefined()
  })

  afterAllFloor(['sin'], () => {
    // Each region the two sides branch on is drawn, so agreement is not
    // agreement over the easy half. Floors at about half of what three runs
    // measured.
    expect(reach.kernel).toBeGreaterThan(300)
    expect(reach.reduced).toBeGreaterThan(200)
    expect(reach.pastCeiling).toBeGreaterThan(100)
    expect(reach.nonFinite).toBeGreaterThan(40)
  })
})
