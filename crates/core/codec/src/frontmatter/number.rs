//! Numbers as the YAML core schema and JavaScript read and print them: radix
//! integers rounded to the nearest double, and the digits of an integer too
//! large for one.

use whiteboard_det::format::js_number_to_string;

/// The greatest integer a double holds exactly, 2^53 - 1.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Little-endian decimal digits of a non-negative integer.
struct Decimal(Vec<u8>);

impl Decimal {
    fn zero() -> Decimal {
        Decimal(Vec::new())
    }

    /// `self * factor + addend`, for single-digit factor and addend.
    fn mul_add(&mut self, factor: u8, addend: u8) {
        let mut carry = u32::from(addend);
        for digit in &mut self.0 {
            let total = u32::from(*digit).saturating_mul(u32::from(factor)).saturating_add(carry);
            *digit = u8::try_from(total % 10).unwrap_or(0);
            carry = total / 10;
        }
        while carry > 0 {
            self.0.push(u8::try_from(carry % 10).unwrap_or(0));
            carry /= 10;
        }
    }

    fn text(&self) -> String {
        if self.0.is_empty() {
            return "0".to_string();
        }
        self.0.iter().rev().map(|d| char::from(b'0'.saturating_add(*d))).collect()
    }
}

/// The nearest double to the integer `digits` spell in a radix of `bits` bits
/// per digit (4 for hex, 3 for octal), ties to even, as `parseInt` rounds. An
/// integer too long for a double is infinite without being read digit by digit.
pub(super) fn radix_to_f64(digits: &str, bits: usize) -> f64 {
    let significant = digits.trim_start_matches('0');
    if significant.len().saturating_mul(bits) > 1100 {
        return f64::INFINITY;
    }
    let radix = 1u8 << bits;
    radix_digits(significant, radix).and_then(|text| text.parse().ok()).unwrap_or(f64::NAN)
}

/// The integer `source` was written as, when it is past 2^53 and the double
/// `parsed` is neither exactly it nor the digits JavaScript prints for that
/// double (`serializeOkf` writes those, so a stored double reads back as
/// itself). `None` when the double holds it as well as a double can.
pub(super) fn written_integer(source: &str, parsed: f64) -> Option<String> {
    if !parsed.is_finite() || parsed.abs() <= MAX_SAFE_INTEGER {
        return None;
    }
    let source = source.strip_prefix('+').unwrap_or(source);
    let written = integer_digits(source)?;
    let exact = exact_digits(parsed);
    (written != exact && written != js_number_to_string(parsed)).then_some(written)
}

/// `BigInt(source)` as signed decimal digits; only a decimal may carry a sign.
fn integer_digits(source: &str) -> Option<String> {
    if let Some(hex) = source.strip_prefix("0x") {
        return radix_digits(hex, 16);
    }
    if let Some(octal) = source.strip_prefix("0o") {
        return radix_digits(octal, 8);
    }
    let (negative, digits) = match source.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, source),
    };
    let trimmed = digits.trim_start_matches('0');
    Some(if trimmed.is_empty() {
        "0".to_string()
    } else if negative {
        format!("-{trimmed}")
    } else {
        trimmed.to_string()
    })
}

fn radix_digits(digits: &str, radix: u8) -> Option<String> {
    let mut value = Decimal::zero();
    for c in digits.chars() {
        value.mul_add(radix, u8::try_from(c.to_digit(16)?).ok()?);
    }
    Some(value.text())
}

/// The exact integer a finite double larger than 2^53 holds, as signed digits.
fn exact_digits(x: f64) -> String {
    let bits = x.abs().to_bits();
    let mantissa = (bits & ((1 << 52) - 1)).saturating_add(1 << 52);
    let shift = (bits >> 52) & 0x7ff;
    let mut value =
        Decimal(mantissa.to_string().bytes().rev().map(|b| b.saturating_sub(b'0')).collect());
    for _ in 0..shift.saturating_sub(1075) {
        value.mul_add(2, 0);
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    format!("{sign}{}", value.text())
}
