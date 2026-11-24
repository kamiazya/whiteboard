//! The CRDT document engine's Rust half, native-only until a wasm export
//! lands. Today it reads the bytes npm `loro-crdt` writes: a deep value, a
//! version vector and frontiers, answered as the TypeScript records them, and
//! a tree container's nodes and the roots beside it, read without writing,
//! writes a tree and its containers one loro call at a time, and answers the
//! document engine's spatial-canvas, document-content, annotation and
//! proposal writers over a document of its own.
//!
//! The `loro` crate is pinned `=` to the version of the npm package
//! (ADR-0054 decision 13). One `LoroDoc` is never split across two engines:
//! only bytes cross, and snapshot bytes are not canonical, so what is
//! compared is the deep value, the version vector and the frontiers.
//!
//! `loro` draws random bytes for every `LoroDoc` (a peer id) and, on wasm32,
//! links `wasm-bindgen` and `getrandom`'s `js` backend unconditionally, so a
//! wasm artifact holding this crate imports wasm-bindgen's modules and must
//! be given randomness by its host. The shipped `whiteboard-wasm` does not
//! link it; `cargo xtask wasm-imports` allows those imports for this crate
//! and for the crates that read a record through it (`CORE_IMPORT_ALLOWANCES`).

#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

mod anchor;
mod annotation_write;
mod annotations;
mod canvas;
mod content;
mod content_digest;
mod content_sync;
mod content_write;
mod copy;
mod engine_write;
mod envelope;
mod frontiers;
mod image_refs;
mod judgement;
mod node_content;
mod ops_since;
mod patch;
mod plain;
mod projection;
mod proposal_write;
mod proposals;
mod read;
mod spatial_batch;
mod spatial_write;
mod stored;
mod subtree;
mod text_limits;
mod tree;
mod write;

pub use content::{
    CONTENT_QUERIES, DocumentKind, Refusal, answer_content_query, document_kind, markdown_body,
    retired_stored_shape,
};
pub use content_digest::{content_digest_of, stable_stringify};
pub use copy::{NodeAt, copy_meta, fill_meta};
pub use engine_write::{
    ENGINE_WRITERS, MoreWriters, WriteAnswer, Written, write_batch, write_batch_with,
};
pub use frontiers::{
    FrontiersError, decode_frontiers, encode_frontiers, frontiers_version, shallow_root_version,
    version_frontiers,
};
pub use judgement::{CONTENT_KEYS, content_digest_of_document, state_size};
pub use loro::{
    ExpandType, ExportMode, LoroDoc, LoroList, LoroMap, LoroMovableList, LoroText, LoroValue,
    StyleConfig, StyleConfigMap, TreeID, VersionVector, loro_value,
};
pub use node_content::sync_node_content;
pub use ops_since::{node_writes_since, nodes_written_since};
pub use projection::{project_node, project_node_without};
pub use read::{
    ImportError, deep_value, frontier_pairs, import_bytes, loro_value_to_value, version_pairs,
};
pub use spatial_write::{Fault, Step};
pub use subtree::{SubtreeCopy, copy_subtree, export_subtree};
pub use text_limits::{BreachShape, TextBreach, Unjudged, judge_state};
pub use tree::{ContainerKind, Entry, NodeId, Tree, peek, tree};
pub use write::{
    WriteError, commit, create_node, deep_value_with_id, delete_meta, delete_node,
    delete_root_entry, move_node, open_meta_container, open_root_list, open_tree, set_meta,
    set_peer_id, set_root_entry,
};
