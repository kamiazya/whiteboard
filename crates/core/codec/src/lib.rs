//! OKF Markdown, JSON Canvas and OCIF serialize and parse. Today the crate
//! holds the OKF frontmatter YAML reader and writer, the first codec module
//! ported to Rust.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod frontmatter;
