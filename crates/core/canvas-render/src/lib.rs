//! Canvas rendering, ported from `packages/canvas-render` (ADR-0054 step 7).
//!
//! Today the SVG backend ([`svg`]) and what it reads from the rest of the
//! package: arrowhead geometry, scene bounds, the sketch ink decomposition,
//! the edge flattener and the keyed scene entries. The backend is pure over a
//! [`whiteboard_scene::Scene`]; layout, measurement and highlighting are not
//! its inputs, so it is held to the TypeScript's recorded answers alone
//! (`tests/svg_oracle.rs`).
//!
//! [`scene_digest`] is the AI-facing spatial digest of a laid-out scene, held to
//! the recorded `scene-digest.jsonl` (`tests/scene_digest_oracle.rs`).
//!
//! Two inputs of the TypeScript backend are not ported: the caller-supplied
//! `icons` and `shapes` tables of `SvgDocumentOptions`, whose Rust shape is a
//! trait over data the plugin crate owns and which no caller has yet. The
//! bundled `visual` plugin's icons and silhouettes are always the tables.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod budoux;
pub mod comments;
pub mod compose_canvas;
pub mod compose_edges;
pub mod compose_node;
pub mod constant_ratio;
pub mod declared_colours;
pub mod edge_arrows;
pub mod edge_flatten;
pub mod fake_measure;
pub mod finite_box;
pub mod font_measure;
pub mod glow;
pub mod ink;
pub mod inline_junction;
pub mod legend;
pub mod legend_geometry;
pub mod linebreak;
pub mod longest_fit;
pub mod measure;
pub mod measure_memo;
pub mod node_box;
pub mod node_outline;
pub mod proposals;
pub mod scale_scene;
pub mod scene_bounds;
pub mod scene_digest;
pub mod scene_entries;
pub mod scene_extent;
pub mod scene_walk;
pub mod seed;
pub mod segment_joins;
pub mod sfnt;
pub mod svg;
pub mod theme;
pub mod translate_scene;
pub mod truncate;
pub mod typeset;
pub mod uax_segments;
pub mod xml_escape;
