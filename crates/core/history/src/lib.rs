//! A document's history as pure mechanics over the workspace record.
//!
//! `packages/history` is the oracle, held by the recorded
//! `crdt-mechanics.jsonl` (`tests/crdt_mechanics_oracle.rs`). What turns a
//! frontier into a version vector or into bytes needs the CRDT engine, so it
//! goes through `whiteboard-crdt` and is native-only (`over_doc`); the
//! checkpoint scheduler is a timer over host ports and is not ported.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod compaction_cut;
pub mod frontiers_base64;
pub mod over_doc;
pub mod retention;
pub mod version_vector;

pub use compaction_cut::compaction_cut;
pub use frontiers_base64::{FrontiersNotBase64, frontiers_from_base64, frontiers_to_base64};
pub use over_doc::compaction_cut_over_doc;
pub use retention::{
    LineageCandidate, MAX_AUTO_PER_DOCUMENT, MAX_MANUAL_PER_DOCUMENT,
    MAX_RESTORE_POINTS_PER_DOCUMENT, RestorePointOptions, SandwichCandidate,
    auto_versions_over_cap, carried_auto_versions_over_cap, restore_point_options,
    sandwiched_auto_version_ids,
};
pub use version_vector::{VersionOrder, VersionVector, compare_versions, intersect_versions};

/// The pause after which a document is considered settled, in milliseconds.
pub const CHECKPOINT_QUIET_MS: u64 = 300_000;
