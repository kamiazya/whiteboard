//! The CRDT document engine's Rust half, native-only until a wasm export
//! lands. Today it reads the bytes npm `loro-crdt` writes: a deep value, a
//! version vector and frontiers, answered as the TypeScript records them, and
//! a tree container's nodes and the roots beside it, read without writing,
//! and writes a tree and its containers one loro call at a time.
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

mod copy;
mod read;
mod subtree;
mod tree;
mod write;

pub use copy::{NodeAt, copy_meta, fill_meta};
pub use loro::{
    ExportMode, LoroDoc, LoroList, LoroMap, LoroMovableList, LoroText, LoroValue, TreeID,
    loro_value,
};
pub use read::{
    ImportError, deep_value, frontier_pairs, import_bytes, loro_value_to_value, version_pairs,
};
pub use subtree::{SubtreeCopy, copy_subtree, export_subtree};
pub use tree::{ContainerKind, Entry, NodeId, Tree, peek, tree};
pub use write::{
    WriteError, commit, create_node, deep_value_with_id, delete_meta, delete_node,
    delete_root_entry, move_node, open_meta_container, open_root_list, set_meta, set_peer_id,
    set_root_entry,
};
