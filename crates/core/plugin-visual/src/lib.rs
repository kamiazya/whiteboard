//! The bundled visual plugin's facet payloads (ADR-0054 decision 12): the
//! types generated from `contracts/facets/visual` and the matchers the
//! contract's patterns stand for, and the plugin loaded from its files into a
//! facet registry. Its renderer contribution and the compat chain join as the
//! plugin track ports them.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod checks;
pub mod host;
pub mod render;
#[path = "generated/visual.rs"]
pub mod visual;
