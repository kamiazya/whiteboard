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
    let magnitude = x.abs();
    if let Some(integer) = small_integer(magnitude) {
        return format!("{sign}{integer}");
    }
    let (digits, exponent) = short_decimal(magnitude).unwrap_or_else(|| shortest_digits(magnitude));
    format!("{sign}{}", layout(&digits, exponent))
}

/// A positive finite `x` that is an integer below 2^53, as an integer. Below
/// 2^53 every integer is a double, so half an ulp of `x` is at most a half,
/// while a spelling with fewer significant digits differs from `x` by at
/// least its last nonzero digit's worth, one or more: the shortest round-trip
/// digits are `x`'s own, trailing zeros aside, and ECMA-262's layout of them
/// is the integer written out (it is below 1e21).
///
/// An integer from one up is normal: the integer is the mantissa, implicit
/// bit included, shifted down past its fraction bits, which are all zero.
/// From 2^53 there is no shift left to make, and the path declines.
fn small_integer(x: f64) -> Option<u64> {
    if x.fract() != 0.0 {
        return None;
    }
    let bits = x.to_bits();
    let shift = 1075_u64.checked_sub((bits >> 52) & 0x7ff)?;
    (bits & ((1 << 52) - 1)).saturating_add(1 << 52).checked_shr(u32::try_from(shift).ok()?)
}

/// ECMAScript `Number.prototype.toFixed(digits)`: the decimal expansion of the
/// double rounded to `digits` places, a tie going to the LARGER magnitude, and
/// the sign of any negative input kept (`(-0.0001).toFixed(3)` is `-0.000`).
/// Rust's `{:.n}` rounds an exact tie to even, so a tie is settled here: `x`
/// is a tie exactly when `|x| * 2^(digits + 1)` is an odd integer, since such a
/// value has `digits + 1` decimal places ending in a five.
#[must_use]
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.abs() >= 1e21 {
        return js_number_to_string(x);
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let magnitude = x.abs();
    format!("{sign}{}", fixed_magnitude(magnitude, digits))
}

/// `toFixed` of a non-negative finite `x` below 1e21.
fn fixed_magnitude(x: f64, digits: usize) -> String {
    let longer = digits.saturating_add(1);
    let scaled = (0..longer).fold(x, |value, _| value * 2.0);
    let odd_integer = scaled.fract().to_bits() == 0 && (scaled % 2.0).to_bits() == 1.0f64.to_bits();
    if !odd_integer {
        return format!("{x:.digits$}");
    }
    round_up_last_five(&format!("{x:.longer$}"))
}

/// A decimal string ending in a five, rounded up at the digit before it.
fn round_up_last_five(text: &str) -> String {
    let kept = text.strip_suffix('5').unwrap_or(text);
    let kept = kept.strip_suffix('.').unwrap_or(kept);
    let mut digits: Vec<u8> = kept.bytes().collect();
    let mut carry = true;
    for digit in digits.iter_mut().rev() {
        if !carry || *digit == b'.' {
            continue;
        }
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit = digit.saturating_add(1);
            carry = false;
        }
    }
    let mut out = String::from_utf8(digits).unwrap_or_default();
    if carry {
        out.insert(0, '1');
    }
    out
}

/// `10^p` for the places [`short_decimal`] tries, each exact.
const SHORT_SCALES: [f64; 8] = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];

/// The shortest round-trip digits of a positive finite `x` that is not an
/// integer, and the power of ten of the first, when they have at most as many
/// places as [`SHORT_SCALES`] holds; [`shortest_digits`] without its two
/// renderings. With `n` the integer nearest the computed `x * 10^p`, for the
/// fewest places `p` that work:
///
/// - `n` is below 2^53, so exact, and `n / 10^p` is one correctly rounded
///   division of two exact doubles: its equalling `x` says the spelling
///   `n * 10^-p` reads back as `x`. It also puts `x * 10^p` below 2^53, so
///   one ulp of `x` is under `2 * 10^-p` (`x` is at least 2^52 ulps) and `x`
///   is under 2^52, where no integer reads back as a number that is not one;
/// - a spelling `m * 10^-q` of fewer places that read back would lie within
///   half an ulp of `x`, so `x * 10^q` within a tenth of `m`, and the computed
///   product (under 2^50) within a sixteenth of the exact one: the search
///   would have found `m` at `q`. So `p` places is the shortest;
/// - of the `p`-place spellings that read back there is one when an ulp of
///   `x` is under `10^-p`. Otherwise `x * 10^p` is at least 2^52 and the
///   computed product is that number rounded half to even to an integer: the
///   nearest spelling, the even one of two equally near, which is ECMA-262's
///   choice among spellings equally short;
/// - `n` ends in no zero, since `n / 10` would have worked one place sooner
///   (or `x` would be an integer), so its digits are the shortest digits.
fn short_decimal(x: f64) -> Option<(String, i64)> {
    SHORT_SCALES.iter().zip(1_i64..).find_map(|(&scale, places)| {
        let n = (x * scale).round();
        if (n / scale).to_bits() != x.to_bits() {
            return None;
        }
        let digits = small_integer(n)?.to_string();
        let first = i64::try_from(digits.len()).ok()?.saturating_sub(1);
        Some((digits, first.saturating_sub(places)))
    })
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
    use super::{
        js_number_to_string, js_to_fixed, layout, scientific, settle_tie, short_decimal,
        small_integer, without_negative_zero,
    };
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_proptest::proptest::prelude::{
        Just, Strategy, any, prop_assert, prop_assert_eq, prop_oneof,
    };
    use whiteboard_proptest::{Floor, check};

    /// The whole algorithm with no shortcut: `{:e}`'s digits, the tie settled
    /// by the exact rendering whatever the number, ECMA-262's layout. What
    /// `js_number_to_string` is judged against for the cases it shortcuts.
    fn unshortened(x: f64) -> String {
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
        let (digits, exponent) = scientific(&format!("{:e}", x.abs()));
        let digits = settle_tie(x.abs(), digits, exponent);
        format!("{sign}{}", layout(&digits, exponent))
    }

    const TENTHS: [f64; 9] = [1.0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];

    /// `hi * 2^32 + lo` as the double nearest it: exact below 2^53.
    fn wide(hi: u32, lo: u32) -> f64 {
        f64::from(hi) * 4_294_967_296.0 + f64::from(lo)
    }

    /// Integers either side of 2^53 and up to 1e21, decimals of a few places,
    /// dyadic fractions (the quarters and eighths whose 17-digit spellings
    /// tie), and any bit pattern at all.
    fn number() -> impl Strategy<Value = f64> {
        let integer = prop_oneof![
            (0u32..1 << 20).prop_map(f64::from),
            (1u32 << 20..1 << 24, any::<u32>()).prop_map(|(hi, lo)| wide(hi, lo)),
            (any::<u32>(), any::<u32>()).prop_map(|(hi, lo)| wide(hi, lo)),
            (1.0e15..1.0e21).prop_map(f64::round),
        ];
        let decimal = decimal();
        let dyadic = (1u32 << 17..1 << 21, any::<u32>(), 1u32..6)
            .prop_map(|(hi, lo, shift)| wide(hi, lo) / f64::from(1u32 << shift));
        // Between 2^50 and 2^51 doubles sit on quarters, so an odd quarter there
        // is exactly halfway between its two 17-digit spellings.
        let halfway = (1u32 << 19..1 << 20, any::<u32>())
            .prop_map(|(hi, lo)| (2.0 * wide(hi, lo) + 1.0) / 4.0);
        // Decimals so large that one ulp is wider than their last place, which
        // two spellings of that many places can then both read back as.
        let coarse = (1u32 << 8..1 << 18, any::<u32>(), 1usize..5)
            .prop_map(|(hi, lo, places)| wide(hi, lo) / TENTHS[places]);
        // Decimals either side of 1e-6, where the layout turns to an exponent:
        // seven places reach 1e-6..1e-5 above it, eight reach under it.
        let tiny = (1i32..100, 7usize..=8).prop_map(|(n, places)| f64::from(n) / TENTHS[places]);
        // Every power of two, normal or not: a mantissa of no stored bits, and
        // a few of them (2^-25 among them) exactly halfway.
        let powers = (0u64..2047).prop_map(|e| f64::from_bits(e << 52).max(5e-324));
        let negated = |s: f64, negative: bool| if negative { -s } else { s };
        let any_number = prop_oneof![
            3 => integer,
            2 => decimal,
            3 => tiny,
            2 => coarse,
            1 => powers,
            3 => dyadic,
            3 => halfway,
            2 => any::<f64>(),
            1 => Just(5e-324),
        ];
        (any_number, any::<bool>()).prop_map(move |(x, negative)| negated(x, negative))
    }

    #[test]
    fn the_shortcuts_print_what_the_whole_algorithm_prints() {
        let integers_past_two_to_the_53 = Floor::new("integers at or past 2^53");
        let ties = Floor::new("halfway numbers settled on the lower, even spelling");
        let short = Floor::new("decimals spelled by the short-places path");
        let below_positional = Floor::new("decimals of a few places under 1e-6");
        check(number(), None, |x| {
            let magnitude = x.abs();
            integers_past_two_to_the_53.draw(
                magnitude.fract() == 0.0 && (9.007_199_254_740_992e15..1e21).contains(&magnitude),
            );
            short.draw(magnitude.fract() != 0.0 && short_decimal(magnitude).is_some());
            below_positional.draw(magnitude < 1e-6 && (magnitude * 1e8).fract() == 0.0);
            let (digits, exponent) = scientific(&format!("{magnitude:e}"));
            ties.draw(
                x.is_finite()
                    && x != 0.0
                    && settle_tie(magnitude, digits.clone(), exponent) != digits,
            );
            prop_assert_eq!(js_number_to_string(x), unshortened(x), "{:e}", x);
            Ok(())
        });
        integers_past_two_to_the_53.assert(5);
        ties.assert(5);
        short.assert(20);
        below_positional.assert(3);
    }

    /// The decimals [`number`] draws: up to seven places, under 1e5 either way.
    fn decimal() -> impl Strategy<Value = f64> {
        (-100_000i32..100_000, 1usize..8).prop_map(|(n, places)| f64::from(n) / TENTHS[places])
    }

    #[test]
    fn every_integer_below_two_to_the_53_takes_the_integer_path() {
        let integer = prop_oneof![
            (1u32..1 << 20).prop_map(f64::from),
            (1u32 << 20..1 << 21, any::<u32>()).prop_map(|(hi, lo)| wide(hi, lo)),
        ];
        check(integer, None, |x| {
            prop_assert!(small_integer(x).is_some(), "{x:e}");
            Ok(())
        });
    }

    #[test]
    fn a_decimal_of_a_few_places_takes_the_short_path() {
        let past_the_floor = Floor::new("decimals with a fraction");
        check(decimal(), None, |x| {
            let magnitude = x.abs();
            past_the_floor.draw(magnitude.fract() != 0.0);
            if magnitude.fract() != 0.0 {
                prop_assert!(short_decimal(magnitude).is_some(), "{x:e}");
            }
            Ok(())
        });
        past_the_floor.assert(100);
    }

    #[test]
    fn a_decimal_whose_ulp_is_wider_than_its_last_place_is_spelled_exactly() {
        // One ulp here is 2^-6, wider than a hundredth, so 86170529150095.09
        // reads back as this double too: the shortest spelling is one place.
        assert_eq!(js_number_to_string(86_170_529_150_095.1), "86170529150095.1");
        assert_eq!(js_number_to_string(72_738_655_603_641.8), "72738655603641.8");
    }

    #[test]
    fn a_halfway_power_of_two_settles_on_the_even_spelling() {
        // 2^-25 is 2.98023223876953125e-8, halfway between its two 17-digit
        // spellings; JavaScript prints the even one. 2^-24 is halfway too, and
        // the even of its two 16-digit spellings does not read back.
        // Biased exponents 998 and 999, with no stored mantissa bits.
        assert_eq!(js_number_to_string(f64::from_bits(998 << 52)), "2.9802322387695312e-8");
        assert_eq!(js_number_to_string(f64::from_bits(999 << 52)), "5.960464477539063e-8");
    }

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

    #[test]
    fn to_fixed_rounds_a_tie_to_the_larger_magnitude_and_keeps_the_sign() {
        let cases: [(f64, usize, &str); 16] = [
            (0.0625, 3, "0.063"),
            (-0.0625, 3, "-0.063"),
            (2.5, 0, "3"),
            (-2.5, 0, "-3"),
            (0.5, 0, "1"),
            (1.5, 0, "2"),
            (1234.5625, 3, "1234.563"),
            (8.0625, 3, "8.063"),
            (0.1875, 3, "0.188"),
            (1.005, 2, "1.00"),
            (0.0001, 3, "0.000"),
            (-0.0001, 3, "-0.000"),
            (123.456, 3, "123.456"),
            (7.0, 3, "7.000"),
            (999.9995, 3, "1000.000"),
            (9.5, 0, "10"),
        ];
        for (x, digits, text) in cases {
            assert_eq!(js_to_fixed(x, digits), text, "{x} to {digits}");
        }
    }

    #[test]
    fn to_fixed_hands_a_huge_or_unreadable_number_to_the_plain_string() {
        assert_eq!(js_to_fixed(1e21, 3), "1e+21");
        assert_eq!(js_to_fixed(-1e21, 3), "-1e+21");
        assert_eq!(js_to_fixed(f64::NAN, 3), "NaN");
        assert_eq!(js_to_fixed(1e20, 1), "100000000000000000000.0");
        assert_eq!(js_to_fixed(f64::INFINITY, 3), "Infinity");
    }

    #[test]
    fn to_fixed_prints_a_zero_of_either_sign_without_one() {
        assert_eq!(js_to_fixed(0.0, 2), "0.00");
        assert_eq!(js_to_fixed(-0.0, 2), "0.00");
        assert_eq!(js_to_fixed(0.0, 0), "0");
    }

    #[test]
    fn to_fixed_carries_through_a_run_of_nines() {
        assert_eq!(js_to_fixed(99.9375, 3), "99.938");
        assert_eq!(js_to_fixed(0.999_999_9, 3), "1.000");
        assert_eq!(js_to_fixed(9.9995, 3), "9.999");
        assert_eq!(js_to_fixed(99.5, 0), "100");
    }
}
