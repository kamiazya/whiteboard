//! Deterministic primitives every core crate builds on.
//!
//! The TypeScript implementation is the oracle, and the oracle is compared
//! BYTE for byte, so anything whose result can differ between engines or
//! targets is defined here once: number formatting that follows ECMAScript
//! rather than Rust's `Display`, math pinned to an exact formula instead of a
//! platform intrinsic, string lengths in UTF-16 code units (what JS `.length`
//! counts), and seeded randomness.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod format;
pub mod math;
pub mod rng;
pub mod utf16;
