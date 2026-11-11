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

/// A deterministic stream of floats in `[0, 1)` from a seed: mulberry32, as
/// canvas-render's `styleRandomFromSeed` draws it.
///
/// Every step is `u32` arithmetic that wraps, which is what the TypeScript's
/// `>>> 0` and `Math.imul` compute: the sum `t + Math.imul(..)` is a double
/// that `^=` reads back as its low 32 bits.
#[derive(Debug, Clone, Copy)]
pub struct StyleRandom {
    state: u32,
}

impl StyleRandom {
    #[must_use]
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// The next float of the stream.
    pub fn next_unit(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 0x3d));
        unit_interval(t ^ (t >> 14))
    }
}

#[cfg(test)]
mod tests {
    use super::{StyleRandom, unit_interval};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn spans_zero_inclusive_to_one_exclusive() {
        assert_eq!(unit_interval(0).to_bits(), 0.0f64.to_bits());
        assert_eq!(unit_interval(1 << 31).to_bits(), 0.5f64.to_bits());
        assert!(unit_interval(u32::MAX) < 1.0);
    }

    #[test]
    fn a_stream_draws_the_values_the_typescript_draws() {
        let cases: [(u32, [f64; 3]); 4] = [
            (0, [0.266_429_208_684_712_65, 0.000_329_745_700_582_861_9, 0.223_272_027_447_819_7]),
            (1, [0.627_073_940_588_161_3, 0.002_735_721_180_215_478, 0.527_447_039_959_952_2]),
            (12345, [0.979_728_267_760_947_3, 0.306_752_264_499_664_3, 0.484_205_421_525_985]),
            (u32::MAX, [0.896_422_614_110_633_7, 0.189_478_256_739_676, 0.715_652_678_161_859_5]),
        ];
        for (seed, expected) in cases {
            let mut stream = StyleRandom::new(seed);
            for want in expected {
                let got = stream.next_unit();
                assert_eq!(got.to_bits(), want.to_bits(), "seed {seed}: {got:e} vs {want:e}");
            }
        }
    }
}
