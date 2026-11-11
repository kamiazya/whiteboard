//! Whether a box can be drawn.

use whiteboard_scene::BoundingBox;

/// Whether every coordinate of a box is a real number. Layout and the SVG
/// backend each skip a box that is not, and both must agree on what that
/// means, so there is one definition.
#[must_use]
pub fn is_finite_box(bbox: &BoundingBox) -> bool {
    [bbox.x, bbox.y, bbox.w, bbox.h].iter().all(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::is_finite_box;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_scene::BoundingBox;

    #[test]
    fn a_box_is_finite_when_all_four_fields_are() {
        let of = |x, y, w, h| is_finite_box(&BoundingBox { x, y, w, h });
        assert!(of(0.0, -1.0, 2.0, 3.0));
        assert!(!of(f64::NAN, 0.0, 1.0, 1.0));
        assert!(!of(0.0, f64::INFINITY, 1.0, 1.0));
        assert!(!of(0.0, 0.0, f64::NEG_INFINITY, 1.0));
        assert!(!of(0.0, 0.0, 1.0, f64::NAN));
    }
}
