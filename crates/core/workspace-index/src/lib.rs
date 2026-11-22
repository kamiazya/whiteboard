//! The document index's pure rules over a workspace tree.
//!
//! `packages/workspace-index` is the oracle, held by the recorded
//! `index-rules.jsonl` (`tests/index_rules_oracle.rs`). Every comparison and
//! length a JavaScript caller observes is over UTF-16 code units; a `&str`
//! holds only well-formed text, so an ill-formed JavaScript string never
//! arrives. What reads a workspace record's bytes is `record`, `index_reads` and
//! `restore_judgement`, over `whiteboard-crdt`; the index's writes are not here.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod content_digest;
pub mod display_name;
pub mod document_path;
pub mod entry;
pub mod first_free_segment;
pub mod index_reads;
pub mod index_rules;
pub mod move_collision;
pub mod node_meta;
pub mod record;
pub mod restore_judgement;
#[cfg(test)]
mod test_record;
pub mod trash;
pub mod walk;

pub use display_name::{
    Named, NamedKind, display_name_key, first_distinct_unnamed_path, moved_display_name_taken,
    shown_name, sibling_display_name_taken,
};
pub use entry::{DocumentEntry, EntryError, Found, entry_of};
pub use first_free_segment::first_free_segment;
pub use index_reads::{
    ReadError, list_documents, list_folder_names, list_pinned_documents, list_trash,
    resolve_document, resolve_document_by_id,
};
pub use index_rules::{
    BlobRef, DisplayNameTaken, Node, TrashEntry, distinct_unnamed_path, is_named_by_another_row,
    refuse_moved_name, refuse_sibling_document_name, same_display_name,
};
pub use move_collision::move_collision;
pub use record::WorkspaceRecord;
pub use restore_judgement::{Placement, restorable_trash_documents};
pub use trash::TrashRow;
