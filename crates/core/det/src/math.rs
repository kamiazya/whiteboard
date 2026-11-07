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

/// The sine of `x`, as fdlibm computes it (the `libm` crate, pinned).
///
/// canvas-render's `det-math.ts` is a port of the same algorithm and is held
/// to the same table (`det-math.oracle.txt`, produced by this crate's libm)
/// bit for bit, so the two agree wherever the layout calls them.
#[must_use]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

/// The cosine of `x`, as fdlibm computes it; see [`sin`].
#[must_use]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

#[cfg(test)]
mod tests {
    use super::hypot;

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
