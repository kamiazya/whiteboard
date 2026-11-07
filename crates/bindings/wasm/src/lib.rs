//! The wasm-bindgen composition root: what the browser and Node load.
//!
//! Its export surface is coarse and JSON-shaped; the TypeScript shim built
//! from the same commit checks [`abi_version`] at init and refuses an
//! artifact whose surface it was not written against.

use wasm_bindgen::prelude::wasm_bindgen;

/// Identifies the exported surface. Change it whenever an export is added,
/// removed or changes shape, so a stale artifact fails at init rather than
/// on its first mismatched call.
pub const ABI_VERSION: &str = "2";

/// The ABI identifier the shim compares against its own.
#[wasm_bindgen]
#[must_use]
pub fn abi_version() -> String {
    ABI_VERSION.to_owned()
}

/// `det::math::hypot` over two arrays, one answer per index.
///
/// The det exports are batched rather than one call per number (QR-22b): the
/// property differential that holds them to canvas-render's `det-math.ts`
/// crosses the boundary once per run. An index past the shorter array has
/// no answer, so the caller passes arrays of one length.
#[wasm_bindgen]
#[must_use]
pub fn det_hypot(dx: &[f64], dy: &[f64]) -> Vec<f64> {
    dx.iter().zip(dy).map(|(&x, &y)| whiteboard_det::math::hypot(x, y)).collect()
}

/// `det::math::sin` over an array; see [`det_hypot`].
#[wasm_bindgen]
#[must_use]
pub fn det_sin(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|&x| whiteboard_det::math::sin(x)).collect()
}

/// `det::math::cos` over an array; see [`det_hypot`].
#[wasm_bindgen]
#[must_use]
pub fn det_cos(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|&x| whiteboard_det::math::cos(x)).collect()
}

#[cfg(test)]
mod tests {
    use super::{ABI_VERSION, abi_version, det_cos, det_hypot, det_sin};

    #[test]
    fn the_det_exports_answer_each_input_in_order() {
        assert_eq!(det_hypot(&[3.0, 5.0], &[4.0, 12.0]), vec![5.0, 13.0]);
        assert_eq!(
            det_sin(&[0.0, -0.0]).iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            vec![0, 1 << 63]
        );
        assert_eq!(det_cos(&[0.0]), vec![1.0]);
        assert_eq!(det_hypot(&[3.0, 1.0], &[4.0]), vec![5.0]);
    }

    #[test]
    fn exports_the_declared_abi_version() {
        assert_eq!(abi_version(), ABI_VERSION);
    }
}
