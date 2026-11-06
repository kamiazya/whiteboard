//! The wasm-bindgen composition root: what the browser and Node load.
//!
//! Its export surface is coarse and JSON-shaped; the TypeScript shim built
//! from the same commit checks [`abi_version`] at init and refuses an
//! artifact whose surface it was not written against.

use wasm_bindgen::prelude::wasm_bindgen;

/// Identifies the exported surface. Change it whenever an export is added,
/// removed or changes shape, so a stale artifact fails at init rather than
/// on its first mismatched call.
pub const ABI_VERSION: &str = "1";

/// The ABI identifier the shim compares against its own.
#[wasm_bindgen]
#[must_use]
pub fn abi_version() -> String {
    ABI_VERSION.to_owned()
}

#[cfg(test)]
mod tests {
    use super::{ABI_VERSION, abi_version};

    #[test]
    fn exports_the_declared_abi_version() {
        assert_eq!(abi_version(), ABI_VERSION);
    }
}
