//! What documents point at: the facts a document contributes, where a name is
//! mentioned outside a link, the edits that link those mentions or follow a
//! rename, and the backlinks a listing answers.
//!
//! `packages/reference-graph` is the oracle, held by the recorded
//! `graph-rules.jsonl` (`tests/graph_rules_oracle.rs`). Every index and length
//! a JavaScript caller observes is in UTF-16 code units, while a `&str` is
//! scanned in bytes, so what crosses the boundary is converted by
//! [`units::UnitOffsets`]. The cache over a port that loads documents is not
//! here: it needs the ports layer.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod backlinks;
pub mod facts;
pub mod in_use;
pub mod linkify;
pub mod markup;
pub mod mentions;
pub mod nodes;
pub mod references;
pub mod rewrite;
pub mod text_limit;
pub mod units;

use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

pub use backlinks::{BacklinkEntry, Backlinks, DocumentEntry, DocumentFacts, backlinks_in};
pub use facts::{
    ContentFacts, LoadedContent, SplitTags, TagBearer, extract_content_facts, split_bearer_tags,
    tag_bearers_of,
};
pub use in_use::{TagInUse, tags_in_use};
pub use linkify::{LinkifyPlan, LinkifyTarget, plan_linkify_mentions};
pub use mentions::{Span, UnlinkedNameSpans, unlinked_name_spans};
pub use references::{NodeVia, RawReference};
pub use rewrite::plan_document_reference_rewrite;
pub use text_limit::{Breach, ReferenceRewriteTooLarge};

/// A document's content, as much of it as the graph reads.
#[derive(Debug, Clone, Copy)]
pub enum DocumentContent<'a> {
    Markdown { body: &'a str },
    Spatial(&'a SpatialCanvas),
}

/// One splice of a markdown body, in UTF-16 units of the body it was planned on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Splice {
    pub index: usize,
    pub remove: usize,
    pub insert: String,
}

/// What a plan asks a keeper to write.
#[derive(Debug, Clone, PartialEq)]
pub enum DocumentEdit {
    /// Targeted text splices, descending, so each is on the original offsets.
    MarkdownSplices(Vec<Splice>),
    MarkdownBody(String),
    /// A canvas planned as a visible diff against the one that was read; boxed
    /// because two canvases dwarf every other variant.
    SpatialCanvas {
        before: Box<SpatialCanvas>,
        after: Box<SpatialCanvas>,
    },
    /// Exactly the nodes that changed, for targeted writes.
    SpatialNodes(Vec<SpatialNode>),
}
