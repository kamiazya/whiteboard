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
    let (digits, exponent) = scientific(&format!("{x:e}"));
    (settle_tie(x, digits, exponent), exponent)
}

/// The digits of a `{:e}` rendering and its power of ten.
fn scientific(text: &str) -> (String, i64) {
    let (mantissa, power) = text.split_once('e').unwrap_or((text, "0"));
    (mantissa.chars().filter(char::is_ascii_digit).collect(), power.parse().unwrap_or(0))
}

/// The most digits a double's exact decimal expansion has (a subnormal's), so
/// that a rendering to this many is exact and not rounded.
const EXACT_DIGITS: usize = 800;

/// `digits` unless `x` lies exactly halfway between two spellings of that
/// length, in which case ECMA-262 picks the one whose last digit is even where
/// Rust's `{:e}` rounds half up. Rounding up already gives the even spelling
/// when the lower one ends in an odd digit, so only an even lower one is
/// looked for, and only when it reads back as `x`.
///
/// Halfway means `x` rendered one digit longer ends in a five and is exact:
/// the first test is the cheap one, and the tenth of numbers that pass it pay
/// for the exact rendering.
fn settle_tie(x: f64, digits: String, exponent: i64) -> String {
    let k = digits.len();
    let (longer, _) = scientific(&format!("{x:.k$e}"));
    if !longer.ends_with('5') {
        return digits;
    }
    let (exact, _) = scientific(&format!("{x:.EXACT_DIGITS$e}"));
    let halfway = exact.get(..longer.len()) == Some(longer.as_str())
        && exact.get(longer.len()..).is_some_and(|rest| rest.bytes().all(|b| b == b'0'));
    let Some(lower) = longer.get(..k).filter(|_| halfway) else { return digits };
    let power = exponent.saturating_add(1);
    let reads_back =
        format!("0.{lower}e{power}").parse::<f64>().is_ok_and(|read| read.to_bits() == x.to_bits());
    if reads_back && lower.ends_with(['0', '2', '4', '6', '8']) {
        lower.to_string()
    } else {
        digits
    }
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
    fn two_shortest_spellings_equally_near_settle_on_the_even_one() {
        // Doubles between 2^50 and 2^51 sit on quarters, so `.25` and `.75` are
        // exactly halfway between two 17-digit spellings; ECMA-262 picks the
        // one whose last digit is even, where Rust's `{:e}` rounds half up.
        // Written as quarters over four, which a literal cannot say exactly.
        let cases: [(f64, &str); 8] = [
            (5_463_662_520_317_985.0 / 4.0, "1365915630079496.2"),
            (5_463_662_520_317_987.0 / 4.0, "1365915630079496.8"),
            (-5_463_662_520_317_985.0 / 4.0, "-1365915630079496.2"),
            (4_503_599_627_370_497.0 / 4.0, "1125899906842624.2"),
            (4_503_599_627_370_501.0 / 4.0, "1125899906842625.2"),
            (4_503_599_627_370_503.0 / 4.0, "1125899906842625.8"),
            (4_503_599_627_370_505.0 / 4.0, "1125899906842626.2"),
            (4_503_599_627_370_507.0 / 4.0, "1125899906842626.8"),
        ];
        for (x, text) in cases {
            assert_eq!(js_number_to_string(x), text, "{x:e}");
        }
    }

    #[test]
    fn a_value_just_off_halfway_takes_the_nearer_spelling_though_the_lower_is_even() {
        // Rendered one digit longer these end in a five, and the lower of their two
        // 17-digit spellings is even and reads back, but they lie a little past the
        // middle, so the upper one is nearer and is what JavaScript prints.
        let cases: [(f64, &str); 4] = [
            (21.653_126_585_297_287, "21.653126585297287"),
            (5.970_440_539_065_748_5, "5.9704405390657485"),
            (0.030_599_815_007_299_185, "0.030599815007299185"),
            (0.060_839_576_176_367_705, "0.060839576176367705"),
        ];
        for (x, text) in cases {
            assert_eq!(js_number_to_string(x), text, "{x:e}");
        }
    }

    #[test]
    fn a_spelling_that_is_nearer_than_its_neighbour_is_not_a_tie() {
        // Not halfway: the nearer 16-digit spelling is the answer, odd or even.
        let cases: [(f64, &str); 5] = [
            (4_503_599_627_370_497.0 / 8.0, "562949953421312.1"),
            (4_503_599_627_370_499.0 / 8.0, "562949953421312.4"),
            (4_503_599_627_370_501.0 / 8.0, "562949953421312.6"),
            (4_503_599_627_370_497.0 / 2.0, "2251799813685248.5"),
            (0.1 + 0.2, "0.30000000000000004"),
        ];
        for (x, text) in cases {
            assert_eq!(js_number_to_string(x), text, "{x:e}");
        }
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
