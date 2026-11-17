// Translated from fdlibm's e_log.c (@(#)e_log.c 1.3 95/01/18), whose notice
// the permission below requires to be kept with any copy:
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================

//! `Math.log` as V8 computes it: Sun's `e_log.c`, written out.
//!
//! The `libm` crate's `log` is not the same function: it answers one ulp away
//! on inputs a ranking reaches (`ln(4/3)` is `0x3fd269621134db92` there and
//! `0x3fd269621134db91` in V8), and a score is compared by its bits.

const LN2_HI: u64 = 0x3fe6_2e42_fee0_0000;
const LN2_LO: u64 = 0x3dea_39ef_3579_3c76;
const TWO54: u64 = 0x4350_0000_0000_0000;
/// `0.33333333333333333`, as the C source rounds it.
const THIRD: u64 = 0x3fd5_5555_5555_5555;
const LG1: u64 = 0x3fe5_5555_5555_5593;
const LG2: u64 = 0x3fd9_9999_9997_fa04;
const LG3: u64 = 0x3fd2_4924_9422_9359;
const LG4: u64 = 0x3fcc_71c5_1d8e_78af;
const LG5: u64 = 0x3fc7_4664_96cb_03de;
const LG6: u64 = 0x3fc3_9a09_d078_c69f;
const LG7: u64 = 0x3fc2_f112_df3e_5244;

fn constant(bits: u64) -> f64 {
    f64::from_bits(bits)
}

/// The high word of `x` as the signed integer the algorithm compares.
fn high_word(x: f64) -> i32 {
    let high = u32::try_from(x.to_bits() >> 32).unwrap_or(0);
    i32::from_ne_bytes(high.to_ne_bytes())
}

fn low_word(x: f64) -> u32 {
    u32::try_from(x.to_bits() & 0xffff_ffff).unwrap_or(0)
}

fn with_high_word(x: f64, high: i32) -> f64 {
    let high = u32::from_ne_bytes(high.to_ne_bytes());
    f64::from_bits((u64::from(high) << 32) | u64::from(low_word(x)))
}

/// `Math.log(x)`.
#[must_use]
pub fn ln(value: f64) -> f64 {
    let mut scaled = value;
    let mut high = high_word(scaled);
    let mut exponent = 0_i32;
    if high < 0x0010_0000 {
        // Below 2**-1022: zero, negative, or subnormal.
        if high.wrapping_shl(1) == 0 && low_word(scaled) == 0 {
            return f64::NEG_INFINITY;
        }
        if high < 0 {
            return f64::NAN;
        }
        exponent = exponent.wrapping_sub(54);
        scaled *= constant(TWO54);
        high = high_word(scaled);
    }
    if high >= 0x7ff0_0000 {
        return scaled + scaled;
    }
    exponent = exponent.wrapping_add((high >> 20).wrapping_sub(1023));
    high &= 0x000f_ffff;
    let carry = high.wrapping_add(0x9_5f64) & 0x0010_0000;
    scaled = with_high_word(scaled, high | (carry ^ 0x3ff0_0000));
    exponent = exponent.wrapping_add(carry >> 20);
    let frac = scaled - 1.0;
    let count = f64::from(exponent);
    if (0x000f_ffff & high.wrapping_add(2)) < 3 {
        // -2**-20 <= frac < 2**-20
        return near_one(frac, count, exponent == 0);
    }
    reduced(frac, count, exponent == 0, high)
}

/// `frac` within 2**-20 of zero, where the series is short.
fn near_one(frac: f64, count: f64, no_exponent: bool) -> f64 {
    let (ln2_hi, ln2_lo) = (constant(LN2_HI), constant(LN2_LO));
    if frac == 0.0 {
        return if no_exponent { 0.0 } else { count * ln2_hi + count * ln2_lo };
    }
    let rest = frac * frac * (0.5 - constant(THIRD) * frac);
    if no_exponent { frac - rest } else { count * ln2_hi - ((rest - count * ln2_lo) - frac) }
}

/// The polynomial for a `frac` away from zero.
fn reduced(frac: f64, count: f64, no_exponent: bool, high: i32) -> f64 {
    let ratio = frac / (2.0 + frac);
    let square = ratio * ratio;
    let fourth = square * square;
    let lower = high.wrapping_sub(0x6_147a);
    let upper = 0x6_b851_i32.wrapping_sub(high);
    let odd = fourth * (constant(LG2) + fourth * (constant(LG4) + fourth * constant(LG6)));
    let even = square
        * (constant(LG1)
            + fourth * (constant(LG3) + fourth * (constant(LG5) + fourth * constant(LG7))));
    let sum = even + odd;
    let (ln2_hi, ln2_lo) = (constant(LN2_HI), constant(LN2_LO));
    if (lower | upper) > 0 {
        let half_square = 0.5 * frac * frac;
        if no_exponent {
            frac - (half_square - ratio * (half_square + sum))
        } else {
            count * ln2_hi - ((half_square - (ratio * (half_square + sum) + count * ln2_lo)) - frac)
        }
    } else if no_exponent {
        frac - ratio * (frac - sum)
    } else {
        count * ln2_hi - ((ratio * (frac - sum) - count * ln2_lo) - frac)
    }
}

#[cfg(test)]
mod tests {
    use super::ln;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn ln_answers_the_bits_v8_answers() {
        // Each pair was read from `Math.log` on Node 24.
        for (x, bits) in [
            (1.0 + 0.5 / 1.5, 0x3fd2_6962_1134_db91_u64),
            (1.0, 0),
            (core::f64::consts::E, 0x3ff0_0000_0000_0000),
            (2.0, 0x3fe6_2e42_fefa_39ef),
            (10.0, 0x4002_6bb1_bbb5_5516),
        ] {
            assert_eq!(ln(x).to_bits(), bits, "ln({x})");
        }
    }

    #[test]
    fn ln_handles_the_edges_as_math_log_does() {
        assert_eq!(ln(0.0).to_bits(), f64::NEG_INFINITY.to_bits());
        assert_eq!(ln(-0.0).to_bits(), f64::NEG_INFINITY.to_bits());
        assert!(ln(-1.0).is_nan() && ln(f64::NAN).is_nan());
        assert_eq!(ln(f64::INFINITY).to_bits(), f64::INFINITY.to_bits());
        assert_eq!(ln(5e-324).to_bits(), 0xc087_4385_446d_71c3);
    }
}
