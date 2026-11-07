//! `det::math::sin` and `cos` against the same table canvas-render's
//! `det-math.ts` is held to, bit for bit. The table is produced by the libm
//! crate at the version this crate pins, never by either port, so the two
//! implementations share the fixture and nothing else.

use whiteboard_det::math::{cos, sin};

const ORACLE: &str = include_str!("../../../../packages/canvas-render/src/det-math.oracle.txt");

#[test]
fn sin_and_cos_match_every_oracle_row_bit_for_bit() {
    let bits = |hex: &str| u64::from_str_radix(hex, 16).unwrap();
    let mut rows = 0;
    for line in ORACLE.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let [x, s, c] = cols[..] else { panic!("malformed oracle row: {line}") };
        let x = f64::from_bits(bits(x));
        assert_eq!(sin(x).to_bits(), bits(s), "sin({x:e})");
        assert_eq!(cos(x).to_bits(), bits(c), "cos({x:e})");
        rows += 1;
    }
    // A table that stopped parsing agrees with everything.
    assert!(rows > 800, "only {rows} oracle rows");
}

#[test]
fn past_the_medium_reductions_ceiling_both_answer_nan_as_det_math_ts_does() {
    // det-math.ts ports fdlibm's medium reduction only and answers NaN from
    // the first double whose high word is 0x413921fb (1647099.0); the twin
    // must too, or the two disagree on every angle past it.
    let ceiling = f64::from_bits(0x4139_21fb_0000_0000);
    for x in [ceiling, -ceiling, 1e7, -1e300, f64::MAX] {
        assert!(sin(x).is_nan(), "sin({x:e})");
        assert!(cos(x).is_nan(), "cos({x:e})");
    }
    let below = f64::from_bits(ceiling.to_bits() - 1);
    assert!(sin(below).is_finite() && cos(below).is_finite());
}
