//! Glow's one number: how far a halo of a given radius reaches past the
//! element it surrounds (ADR-0030 decision 8).

/// The backend blurs with a standard deviation of this share of the radius.
pub const GLOW_STD_DEVIATION_RATIO: f64 = 0.5;

/// A Gaussian is visually spent at three deviations, so the reach is 1.5
/// radii rounded up to whole pixels; a radius that is not a positive finite
/// number reaches nothing. `sceneBounds` adds it for a glowing node and the
/// backend pads each glowing element's filter region by it, so one constant
/// has two readers.
#[must_use]
pub fn glow_reach_px(radius_px: f64) -> f64 {
    if !radius_px.is_finite() || radius_px <= 0.0 {
        return 0.0;
    }
    (radius_px * GLOW_STD_DEVIATION_RATIO * 3.0).ceil()
}

#[cfg(test)]
mod tests {
    use super::glow_reach_px;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn the_reach_is_one_and_a_half_radii_rounded_up() {
        assert_eq!(glow_reach_px(4.0).to_bits(), 6.0f64.to_bits());
        assert_eq!(glow_reach_px(3.0).to_bits(), 5.0f64.to_bits());
        assert_eq!(glow_reach_px(0.1).to_bits(), 1.0f64.to_bits());
    }

    #[test]
    fn a_radius_that_is_not_a_positive_number_reaches_nothing() {
        for radius in [0.0, -2.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(glow_reach_px(radius).to_bits(), 0.0f64.to_bits());
        }
    }
}
