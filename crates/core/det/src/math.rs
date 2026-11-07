//! Math pinned to an exact formula.
//!
//! `f64::hypot`, `sin`, `cos` and the other transcendental methods are
//! documented as non-deterministic across platforms, and JS `Math.*` is
//! implementation-defined, so neither side may call them: both use the
//! formulas defined here (and their TypeScript twins). `+`, `*` and `sqrt`
//! are correctly rounded by IEEE 754 on every target, which is what makes
//! these definitions portable.

/// The Euclidean length of `(dx, dy)` as `sqrt(dx*dx + dy*dy)`.
///
/// Deliberately NOT `f64::hypot`: the platform hypot avoids intermediate
/// overflow and so rounds differently, and a one-ulp difference can flip a
/// routing tie-break. This overflows to infinity past ~1.3e154, exactly as
/// its TypeScript twin does.
#[must_use]
pub fn hypot(dx: f64, dy: f64) -> f64 {
    (dx * dx + dy * dy).sqrt()
}

/// The first magnitude [`sin`] and [`cos`] refuse: the double whose high word
/// is `0x413921fb`, about 2^20 * pi/2.
///
/// Past it fdlibm needs its multi-precision argument reduction, which
/// canvas-render's `det-math.ts` does not port (no layout angle comes near
/// it) and answers NaN for instead. Its twin answers NaN from the same
/// double, so the two agree on every input rather than only below it.
const REDUCTION_CEILING: f64 = 1_647_099.0;

/// The sine of `x`, as fdlibm computes it (the `libm` crate, pinned), for
/// `|x|` below [`REDUCTION_CEILING`]; NaN at or past it.
///
/// canvas-render's `det-math.ts` is a port of the same algorithm and is held
/// to the same table (`det-math.oracle.txt`, produced by this crate's libm)
/// bit for bit, and to this function by a property differential through the
/// wasm build.
#[must_use]
pub fn sin(x: f64) -> f64 {
    if x.abs() >= REDUCTION_CEILING { f64::NAN } else { libm::sin(x) }
}

/// The cosine of `x`, as fdlibm computes it; see [`sin`].
#[must_use]
pub fn cos(x: f64) -> f64 {
    if x.abs() >= REDUCTION_CEILING { f64::NAN } else { libm::cos(x) }
}

/// `Math.min(a, b)`: NaN if either is NaN, and `-0` below `+0`.
///
/// `f64::min` answers the other operand for a NaN and leaves the sign of a
/// zero unspecified, so a port that called it would disagree with its
/// TypeScript oracle on exactly the inputs a property draws.
#[must_use]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN if either is NaN, and `+0` above `-0`; see [`js_min`].
#[must_use]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if b > a || (a <= b && a.is_sign_negative()) {
        b
    } else {
        a
    }
}

/// `Math.round(x)`: halves round toward positive infinity, and a result of
/// zero from a negative `x` is `-0`.
///
/// `f64::round` rounds halves away from zero (`-2.5` to `-3` where JS answers
/// `-2`) and never answers `-0` for `-0.3`, so it is not the oracle's
/// rounding, and neither is rounding ties to even. `x - x.floor()` is exact for
/// every finite double, so the comparison against one half is too.
#[must_use]
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() { -0.0 } else { rounded }
}

#[cfg(test)]
mod tests {
    use super::{hypot, js_max, js_min, js_round};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn the_reduction_ceiling_is_the_double_det_math_ts_names_by_its_high_word() {
        assert_eq!(super::REDUCTION_CEILING.to_bits(), 0x4139_21fb_0000_0000);
    }

    #[test]
    fn js_min_and_max_propagate_nan_and_order_signed_zeros_as_math_does() {
        assert!(js_min(f64::NAN, 1.0).is_nan() && js_min(1.0, f64::NAN).is_nan());
        assert!(js_max(f64::NAN, 1.0).is_nan() && js_max(1.0, f64::NAN).is_nan());
        assert_eq!(js_min(-0.0, 0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(js_min(0.0, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(js_max(-0.0, 0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_max(0.0, -0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_min(2.0, -3.0).to_bits(), (-3.0f64).to_bits());
        assert_eq!(js_max(2.0, -3.0).to_bits(), 2.0f64.to_bits());
        assert_eq!(js_min(f64::NEG_INFINITY, 0.0).to_bits(), f64::NEG_INFINITY.to_bits());
    }

    #[test]
    fn js_round_rounds_halves_up_and_keeps_a_negative_zero_as_math_round_does() {
        // Each pair is Math.round's answer in Node, read off rather than derived.
        for (x, js) in [
            (2.5, 3.0),
            (-2.5, -2.0),
            (1.5, 2.0),
            (-1.5, -1.0),
            (0.499_999_999_999_999_94, 0.0),
            (4_503_599_627_370_497.0, 4_503_599_627_370_497.0),
            (f64::INFINITY, f64::INFINITY),
        ] {
            assert_eq!(js_round(x).to_bits(), f64::to_bits(js), "Math.round({x})");
        }
        for x in [-0.5, -0.3, -0.0] {
            assert_eq!(js_round(x).to_bits(), (-0.0f64).to_bits(), "Math.round({x}) is -0");
        }
        assert!(js_round(f64::NAN).is_nan());
    }

    #[test]
    fn pythagorean_triple_is_exact() {
        assert_eq!(hypot(3.0, 4.0).to_bits(), 5.0f64.to_bits());
        assert_eq!(hypot(-3.0, -4.0).to_bits(), 5.0f64.to_bits());
    }

    #[test]
    fn overflows_like_the_naive_formula() {
        // The platform hypot would answer ~1.414e200 here.
        assert!(hypot(1e200, 1e200).is_infinite());
    }
}
