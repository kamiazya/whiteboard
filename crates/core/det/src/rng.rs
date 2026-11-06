//! Seeded randomness.
//!
//! Every "random" choice a render makes is a pure function of stable node
//! identity, so a canvas renders byte-identically twice. The streams live
//! here so that the TypeScript twin and this crate draw identical sequences.

/// Maps a 32-bit state onto `[0, 1)` the way a JS generator does with
/// `(t >>> 0) / 4294967296`: exact, since every `u32` is representable.
#[must_use]
pub fn unit_interval(state: u32) -> f64 {
    f64::from(state) / 4_294_967_296.0
}

#[cfg(test)]
mod tests {
    use super::unit_interval;

    #[test]
    fn spans_zero_inclusive_to_one_exclusive() {
        assert_eq!(unit_interval(0).to_bits(), 0.0f64.to_bits());
        assert_eq!(unit_interval(1 << 31).to_bits(), 0.5f64.to_bits());
        assert!(unit_interval(u32::MAX) < 1.0);
    }
}
