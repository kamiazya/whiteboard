//! An offset a caller counted, as JavaScript reads the number it sent.

/// `usize` of an offset a caller counted: a non-negative safe integer, read
/// through its digits, saturating where the target is narrower than it,
/// which costs nothing a body that long could answer; anything else is
/// `usize::MAX`, past every body. `-0` is JavaScript's `0` (`-0 === 0`, and
/// Zod's non-negative integer admits it), whose digits Rust writes `-0`, so
/// it is read as the zero it equals.
pub(crate) fn offset(n: f64) -> usize {
    format!("{}", n + 0.0).parse().unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::offset;

    #[test]
    fn a_negative_zero_offset_is_the_start() {
        assert_eq!(offset(-0.0), 0);
        assert_eq!(offset(0.0), 0);
        assert_eq!(offset(4.0), 4);
    }

    #[test]
    fn an_offset_no_body_can_hold_is_past_every_body() {
        assert_eq!(offset(-1.0), usize::MAX);
        assert_eq!(offset(0.5), usize::MAX);
        assert_eq!(offset(f64::NAN), usize::MAX);
        assert_eq!(offset(f64::INFINITY), usize::MAX);
        assert_eq!(offset(1e30), usize::MAX);
    }
}
