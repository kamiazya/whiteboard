//! Lexical search: what a text is compared as, and the words it is cut into.
//!
//! The TypeScript package `packages/search` is the oracle, held by the
//! recorded `search.jsonl` (`tests/search_oracle.rs`). Offsets are UTF-16 code
//! units, what a JavaScript caller indexes a string by; every text a `&str`
//! holds is well-formed, so an ill-formed JavaScript string never arrives.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

mod cluster;
pub mod excerpt;
pub mod fold;
pub mod index;
mod markup;
pub mod rank;
pub mod snippet;
mod tables;
pub mod terms;
pub mod texts;
pub mod tokenize;
pub mod unicode;
mod units;

pub use cluster::grapheme_cuts;
pub use excerpt::{EXCERPT_TOKENS_MAX, Excerpter, excerpter_for};
pub use fold::{Folded, Found, find_folded, fold_for_search, fold_with_offsets, span_of};
pub use index::{DEFAULT_LIMIT, SearchIndex, TERM_OVERHEAD, cost_of};
pub use markup::LinkLabel;
pub use rank::{SearchHit, SearchOptions, SearchableDocument, full_text_search};
pub use snippet::{CONTEXT_RADIUS, LinkEntry, LinkLabels, snippet_around};
pub use terms::{AlsoIndex, DOCUMENT_TERMS_MAX, DocumentTerms, document_terms};
pub use texts::{SearchableContent, folder_names_of, searchable_texts};
pub use tokenize::{tokenize, tokenize_for_index, tokenize_runs};
