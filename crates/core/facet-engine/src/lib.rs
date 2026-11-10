//! The facet engine's asset shapes (ADR-0054 decision 12): the types
//! generated from `contracts/facets/engine` and the matchers the contract's
//! patterns stand for. The registry, write validation and the compat chain
//! join as the engine track ports them.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]
#![forbid(unsafe_code)]

pub mod checks;
#[path = "generated/engine.rs"]
pub mod engine;
