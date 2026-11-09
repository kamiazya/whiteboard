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

/// ECMAScript `Number::toString(x)` (radix 10): the shortest digits that read
/// back as `x`, laid out in positional form between 1e-7 and 1e21 and in
/// exponent form outside it. Rust's `{}` never uses an exponent and `{:e}`
/// spells it differently, so the digits come from `{:e}` (shortest and
/// closest, as the ECMAScript algorithm picks them) and the layout is
/// ECMA-262's.
#[must_use]
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    if x.is_infinite() {
        return format!("{sign}Infinity");
    }
    let (digits, exponent) = shortest_digits(x.abs());
    format!("{sign}{}", layout(&digits, exponent))
}

/// The shortest round-trip digits of a positive finite `x` and the power of
/// ten of the first: `x = 0.d1d2... * 10^(exponent + 1)`.
fn shortest_digits(x: f64) -> (String, i64) {
    let scientific = format!("{x:e}");
    let (mantissa, power) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits = mantissa.chars().filter(char::is_ascii_digit).collect();
    (digits, power.parse().unwrap_or(0))
}

/// ECMA-262 `Number::toString` steps 6 to 12 for `k` digits whose first sits at
/// `10^exponent`.
fn layout(digits: &str, exponent: i64) -> String {
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let n = exponent.saturating_add(1);
    let zeros = |count: i64| "0".repeat(usize::try_from(count).unwrap_or(0));
    if k <= n && n <= 21 {
        return format!("{digits}{}", zeros(n.saturating_sub(k)));
    }
    if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(n).unwrap_or(0).min(digits.len()));
        return format!("{whole}.{fraction}");
    }
    if -6 < n && n <= 0 {
        return format!("0.{}{digits}", zeros(n.saturating_neg()));
    }
    let sign = if exponent.is_negative() { '-' } else { '+' };
    let power = exponent.unsigned_abs();
    match digits.split_at_checked(1) {
        Some((first, rest)) if !rest.is_empty() => format!("{first}.{rest}e{sign}{power}"),
        _ => format!("{digits}e{sign}{power}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{js_number_to_string, without_negative_zero};
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

    #[test]
    fn numbers_print_as_ecmascript_prints_them() {
        let cases: [(f64, &str); 22] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (123_456.789, "123456.789"),
            (0.1, "0.1"),
            (0.000_001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (100.0, "100"),
            (1.0e5, "100000"),
            (-1e-7, "-1e-7"),
        ];
        for (x, text) in cases {
            assert_eq!(js_number_to_string(x), text, "{x:e}");
        }
    }
}
