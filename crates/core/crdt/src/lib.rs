//! The CRDT document engine's Rust half, native-only until a wasm export
//! lands. Today it reads the bytes npm `loro-crdt` writes: a deep value, a
//! version vector and frontiers, answered as the TypeScript records them.
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
//! alone (`CORE_IMPORT_ALLOWANCES`).

#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

mod read;

pub use loro::LoroDoc;
pub use read::{
    ImportError, deep_value, frontier_pairs, import_bytes, loro_value_to_value, version_pairs,
};
