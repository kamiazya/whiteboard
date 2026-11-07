/**
 * Math pinned to an exact formula, the TypeScript twin of `crates/core/det`'s
 * `math.rs` (ADR-0054 decision 11, the det precursor).
 *
 * `Math.hypot`, `Math.sin` and `Math.cos` are implementation-approximated by
 * ECMAScript, so two engines — or this oracle and its Rust port — may answer
 * them a unit in the last place apart, and one ulp can flip a routing
 * tie-break or a `toFixed` digit. Layout calls these instead. `+`, `*`, `/`
 * and `Math.sqrt` are correctly rounded by IEEE 754 everywhere, which is what
 * makes every definition below portable.
 */

/**
 * The Euclidean length of `(dx, dy)` as `sqrt(dx*dx + dy*dy)`.
 *
 * Deliberately not `Math.hypot`: an engine's hypot scales to avoid
 * intermediate overflow and so rounds differently. This overflows to
 * infinity past ~1.3e154, exactly as its Rust twin does.
 */
export function hypot(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * A total order on numbers, ascending: `-0` equals `0`, and NaN sorts after
 * every number and equals itself.
 *
 * A comparator written as `a - b` answers NaN for a NaN key, which
 * `Array.prototype.sort` reads as "equal to everything" — no order at all, so
 * where the key lands is the engine's sort algorithm and a port running
 * another algorithm lands it elsewhere. On any two non-NaN numbers this has
 * the sign `a - b` has, which is all a sort reads, so nothing ordered before
 * moves. This is the NaN policy ADR-0054 decision 11 asks the oracle to write
 * down; the Rust twin is `f64::total_cmp` with both zeros and every NaN folded.
 */
export function compareNumbers(a: number, b: number): -1 | 0 | 1 {
  if (a < b) return -1
  if (a > b) return 1
  if (a === b) return 0
  const aNaN = Number.isNaN(a)
  if (aNaN === Number.isNaN(b)) return 0
  return aNaN ? 1 : -1
}

// fdlibm's sine and cosine, as musl carries them (src/math/sin.c, cos.c,
// __sin.c, __cos.c, __rem_pio2.c), line for line. Rust's `libm` crate is the
// same port, so the two languages share one algorithm rather than two
// approximations.

const words = new DataView(new ArrayBuffer(8))

/** The high 32 bits of `x`'s IEEE 754 encoding. */
function highWord(x: number): number {
  words.setFloat64(0, x)
  return words.getUint32(0)
}

// Every constant below is fdlibm's, spelled as the shortest decimal that reads
// back as the same double (its 21-digit source spelling holds more digits than
// a double keeps).
const S1 = -0.16666666666666632
const S2 = 0.00833333333332249
const S3 = -0.0001984126982985795
const S4 = 0.0000027557313707070068
const S5 = -2.5050760253406863e-8
const S6 = 1.58969099521155e-10

/** fdlibm `__sin`: sine on [-pi/4, pi/4], `y` the tail of the reduced argument. */
function kernelSin(x: number, y: number, iy: 0 | 1): number {
  const z = x * x
  const w = z * z
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6)
  const v = z * x
  if (iy === 0) return x + v * (S1 + z * r)
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}

const C1 = 0.0416666666666666
const C2 = -0.001388888888887411
const C3 = 0.00002480158728947673
const C4 = -2.7557314351390663e-7
const C5 = 2.087572321298175e-9
const C6 = -1.1359647557788195e-11

/** fdlibm `__cos`: cosine on [-pi/4, pi/4], `y` the tail of the reduced argument. */
function kernelCos(x: number, y: number): number {
  const z = x * x
  const w = z * z
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6))
  const hz = 0.5 * z
  const one = 1.0 - hz
  return one + (1.0 - one - hz + (z * r - x * y))
}

const TO_INT = 1.5 / Number.EPSILON
const INVPIO2 = 0.6366197723675814
const PIO2_1 = 1.5707963267341256
const PIO2_1T = 6.077100506506192e-11
const PIO2_2 = 6.077100506303966e-11
const PIO2_2T = 2.0222662487959506e-21
const PIO2_3 = 2.0222662487111665e-21
const PIO2_3T = 8.4784276603689e-32

/** A reduced argument: `x - n*pi/2 = head + tail`, with `n` the quadrant count. */
interface Reduced {
  readonly n: number
  readonly head: number
  readonly tail: number
}

function nearMultiple(x: number, k: number, sign: boolean): Reduced {
  const z = sign ? x + k * PIO2_1 : x - k * PIO2_1
  const head = sign ? z + k * PIO2_1T : z - k * PIO2_1T
  const tail = sign ? z - head + k * PIO2_1T : z - head - k * PIO2_1T
  return { n: sign ? -k : k, head, tail }
}

/** fdlibm's Cody-Waite reduction, good for |x| < 2^20 * pi/2. */
function medium(x: number, ix: number): Reduced {
  // Without musl's later directed-rounding correction, which moves `n` at an
  // exact quadrant tie (cos(-23pi/4) comes back one ulp apart): the Rust
  // `libm` crate the det crate wraps reduces this way, and the twin is that.
  const fn = x * INVPIO2 + TO_INT - TO_INT
  const n = fn | 0
  let r = x - fn * PIO2_1
  let w = fn * PIO2_1T
  let head = r - w
  const ex = ix >>> 20
  let ey = (highWord(head) >>> 20) & 0x7ff
  if (ex - ey > 16) {
    let t = r
    w = fn * PIO2_2
    r = t - w
    w = fn * PIO2_2T - (t - r - w)
    head = r - w
    ey = (highWord(head) >>> 20) & 0x7ff
    if (ex - ey > 49) {
      t = r
      w = fn * PIO2_3
      r = t - w
      w = fn * PIO2_3T - (t - r - w)
      head = r - w
    }
  }
  return { n, head, tail: r - head - w }
}

/**
 * fdlibm `__rem_pio2` for every argument this module accepts. Past
 * 2^20 * pi/2 (~1.6e6) fdlibm needs its multi-precision reduction, which no
 * layout reaches — every angle here is a fraction of a turn — so the
 * reduction answers `undefined` there and the caller answers NaN.
 * ponytail: medium reduction only; port `__rem_pio2_large` if a caller ever
 * passes an angle past ~1.6e6 radians.
 */
function remPio2(x: number): Reduced | undefined {
  const hx = highWord(x)
  const sign = hx >>> 31 === 1
  const ix = hx & 0x7fffffff
  if (ix <= 0x400f6a7a) {
    if ((ix & 0xfffff) === 0x921fb) return medium(x, ix)
    return nearMultiple(x, ix <= 0x4002d97c ? 1 : 2, sign)
  }
  if (ix <= 0x401c463b) {
    if (ix <= 0x4015fdbc) {
      if (ix === 0x4012d97c) return medium(x, ix)
      return nearMultiple(x, 3, sign)
    }
    if (ix === 0x401921fb) return medium(x, ix)
    return nearMultiple(x, 4, sign)
  }
  if (ix < 0x413921fb) return medium(x, ix)
  return undefined
}

/** The sine of `x` radians, fdlibm's, for |x| below ~1.6e6; NaN past it and for a non-finite `x`. */
export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e500000) return x
    return kernelSin(x, 0, 0)
  }
  if (ix >= 0x7ff00000) return Number.NaN
  const reduced = remPio2(x)
  if (reduced === undefined) return Number.NaN
  const { n, head, tail } = reduced
  switch (n & 3) {
    case 0:
      return kernelSin(head, tail, 1)
    case 1:
      return kernelCos(head, tail)
    case 2:
      return -kernelSin(head, tail, 1)
    default:
      return -kernelCos(head, tail)
  }
}

/** The cosine of `x` radians, fdlibm's, for |x| below ~1.6e6; NaN past it and for a non-finite `x`. */
export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1
    return kernelCos(x, 0)
  }
  if (ix >= 0x7ff00000) return Number.NaN
  const reduced = remPio2(x)
  if (reduced === undefined) return Number.NaN
  const { n, head, tail } = reduced
  switch (n & 3) {
    case 0:
      return kernelCos(head, tail)
    case 1:
      return -kernelSin(head, tail, 1)
    case 2:
      return -kernelCos(head, tail)
    default:
      return kernelSin(head, tail, 1)
  }
}
