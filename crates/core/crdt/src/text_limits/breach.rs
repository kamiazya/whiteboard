//! What a breach says: its shape, the code a keeper refuses it with, and the
//! fields the TypeScript's `SyncTextBreach` carries for it.
//!
//! The codes are `SYNC_TEXT_BREACH_CODES` of `contracts/api/refusals.json`,
//! carried here as strings because this crate sits below the generated
//! contract crate; `tests/text_limit_cases.rs` holds the two equal.

use whiteboard_model::Value;

/// Every shape a sync write's text judgement can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreachShape {
    Run,
    Body,
    Runs,
    NodeText,
    NodeLocation,
    Label,
    CommentMessage,
    ContainerName,
    ThreadAnchor,
    AnchorQuote,
    OpenThreads,
    OpenChanges,
    ThreadMessages,
    Tags,
    CanvasSize,
    ContentRoot,
    UnattachedContainer,
    ReservedMapKey,
    RetiredShape,
    RetiredCommentPlane,
}

impl BreachShape {
    /// Every shape, in the order the contract's table lists them.
    pub const ALL: [Self; 20] = [
        Self::Run,
        Self::Body,
        Self::Runs,
        Self::NodeText,
        Self::NodeLocation,
        Self::Label,
        Self::CommentMessage,
        Self::ContainerName,
        Self::ThreadAnchor,
        Self::AnchorQuote,
        Self::OpenThreads,
        Self::OpenChanges,
        Self::ThreadMessages,
        Self::Tags,
        Self::CanvasSize,
        Self::ContentRoot,
        Self::UnattachedContainer,
        Self::ReservedMapKey,
        Self::RetiredShape,
        Self::RetiredCommentPlane,
    ];

    /// The shape as the wire writes it.
    #[must_use]
    pub const fn wire(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Body => "body",
            Self::Runs => "runs",
            Self::NodeText => "node-text",
            Self::NodeLocation => "node-location",
            Self::Label => "label",
            Self::CommentMessage => "comment-message",
            Self::ContainerName => "container-name",
            Self::ThreadAnchor => "thread-anchor",
            Self::AnchorQuote => "anchor-quote",
            Self::OpenThreads => "open-threads",
            Self::OpenChanges => "open-changes",
            Self::ThreadMessages => "thread-messages",
            Self::Tags => "tags",
            Self::CanvasSize => "canvas-size",
            Self::ContentRoot => "content-root",
            Self::UnattachedContainer => "unattached-container",
            Self::ReservedMapKey => "reserved-map-key",
            Self::RetiredShape => "retired-shape",
            Self::RetiredCommentPlane => "retired-comment-plane",
        }
    }

    /// The refusal code either keeper answers the shape with.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Run | Self::Body | Self::Runs => "markdown_too_large",
            Self::NodeText => "node_text_too_large",
            Self::NodeLocation => "node_location_too_large",
            Self::Label => "label_too_large",
            Self::CommentMessage => "comment_too_large",
            Self::ContainerName => "container_name_too_long",
            Self::ThreadAnchor => "comment_anchor_too_large",
            Self::AnchorQuote => "anchor_quote_too_long",
            Self::OpenThreads => "too_many_open_threads",
            Self::OpenChanges => "too_many_open_changes",
            Self::ThreadMessages => "too_many_thread_messages",
            Self::Tags => "tags_too_large",
            Self::CanvasSize => "too_many_nodes_or_edges",
            Self::ContentRoot => "invalid_document_root",
            Self::UnattachedContainer => "causal_gap",
            Self::ReservedMapKey => "reserved_map_key",
            Self::RetiredShape => "retired_stored_shape",
            Self::RetiredCommentPlane => "retired_comment_plane",
        }
    }
}

/// A limit a document's state breaks: the shape and what it says of it.
#[derive(Debug, Clone, PartialEq)]
pub struct TextBreach {
    pub shape: BreachShape,
    /// The fields beside `shape`, in the order the TypeScript writes them.
    pub fields: Vec<(&'static str, Value)>,
}

impl TextBreach {
    pub(super) fn new(shape: BreachShape, fields: Vec<(&'static str, Value)>) -> Self {
        Self { shape, fields }
    }

    /// The breach as the engine's read answers it.
    #[must_use]
    pub fn value(&self) -> Value {
        let mut entries = vec![("shape".to_owned(), Value::String(self.shape.wire().to_owned()))];
        entries.extend(self.fields.iter().map(|(key, held)| ((*key).to_owned(), held.clone())));
        Value::Map(entries)
    }
}

/// A count or a length as the wire's number.
pub(super) fn count(amount: usize) -> Value {
    Value::Number(f64::from(u32::try_from(amount).unwrap_or(u32::MAX)))
}

pub(super) fn text(held: &str) -> Value {
    Value::String(held.to_owned())
}
