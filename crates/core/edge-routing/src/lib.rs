//! Edge routing for spatial canvases: the first package ported to Rust.
//!
//! It will hold side choice, anchor placement, the Hanan-grid A* search,
//! crossing detection and reduction, line jumps, corner rounding, the label
//! anchor, the search budget and the route cache — today's
//! `canvas-render/src/layout/edges`. It takes a narrow input (node rects,
//! groups, edges, styles, frozen sides, budget) rather than whole documents,
//! which is what lets it sit below the composer.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod edge_geometry;
pub mod edge_ink;
pub mod edge_rounding;
#[path = "generated/geometry.rs"]
pub mod geometry;
pub mod grid_route;
mod min_heap;
pub mod segment_intersection;
