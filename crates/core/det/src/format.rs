//! ECMAScript-compatible number formatting.
//!
//! Rust's `Display` and `{:.n}` disagree with JS `String(n)` and `toFixed`
//! (exponent rules, the `toFixed` tie rule, `-0`), so byte-compared output is
//! formatted here and nowhere else.

/// Collapses `-0` to `0`, as JS does when it prints a number: `String(-0)`
/// and `(-0).toFixed(2)` both drop the sign, while Rust prints `-0`.
#[must_use]
pub fn without_negative_zero(x: f64) -> f64 {
    if x == 0.0 { 0.0 } else { x }
}

#[cfg(test)]
mod tests {
    use super::without_negative_zero;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn negative_zero_loses_its_sign() {
        assert!(without_negative_zero(-0.0).is_sign_positive());
        assert_eq!(format!("{}", without_negative_zero(-0.0)), "0");
    }

    #[test]
    fn every_other_value_is_unchanged() {
        assert_eq!(without_negative_zero(-1.5).to_bits(), (-1.5f64).to_bits());
        assert_eq!(without_negative_zero(2.0).to_bits(), 2.0f64.to_bits());
        assert!(without_negative_zero(f64::NAN).is_nan());
    }
}
