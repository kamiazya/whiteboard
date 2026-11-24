//! A text limit a document's state breaks, refused in the words that name the
//! document (server-core's `textBreachRefusal` with `{ path }`): what a
//! person fixing a stored document looks for, rather than what an update
//! would do.

use whiteboard_api_contracts::Refusal;
use whiteboard_crdt::{BreachShape, TextBreach};
use whiteboard_model::Value;

/// `MARKDOWN_MAX_CHARS`.
const MARKDOWN_MAX_CHARS: u64 = 262_144;

/// The `*_LIMIT_PHRASE`s of `@kamiazya/whiteboard-model`, each the sentence a
/// refusal ends its bound with; `tests` holds them to the contract's examples.
pub(crate) mod phrase {
    pub(crate) const MARKDOWN: &str =
        "the 262144-character limit for one document; split the content across documents";
    pub(crate) const NODE_TEXT: &str = "the 8192-character limit for one node; split it across nodes, or put it in a markdown document and embed that";
    pub(crate) const NODE_LOCATION: &str = "the 8192-character limit";
    pub(crate) const LABEL: &str = "the 1024-character limit; a longer text belongs in a text node";
    pub(crate) const COMMENT_MESSAGE: &str = "the 4096-character limit; split it across replies";
    pub(crate) const CONTAINER_NAME: &str = "the 1024-character limit for the name of one container; a thread or a proposal is named by its id";
    pub(crate) const ANCHOR_NODES: &str =
        "the 2000-node limit for one comment anchor, a whole canvas's worth";
    pub(crate) const TEXT_ANCHOR_QUOTE: &str = "the 1024-character limit for the passage one anchor quotes; quote a shorter passage, or split a replacement across changes";
    pub(crate) const OPEN_THREADS: &str =
        "the limit of 500 open comment threads for one document; resolve some first";
    pub(crate) const OPEN_CHANGES: &str =
        "the limit of 1000 open proposed changes for one document; adopt or dismiss some first";
    pub(crate) const THREAD_MESSAGES: &str =
        "the limit of 1000 messages in one comment thread; open a new thread to continue";
    pub(crate) const TAG_COUNT: &str = "the 1024-tag limit for one document, board, node or edge";
    pub(crate) const TAG_LENGTH: &str = "the 1024-character limit for one tag";
    pub(crate) const CANVAS_NODES: &str = "the 2000-node limit for one canvas; remove nodes first, or split the board across canvases";
    pub(crate) const CANVAS_EDGES_AND_LINES: &str = "the limit of 2000 edges and lines together for one canvas; remove edges or lines first, or split the board across canvases";
}

/// The field `key` of the breach.
fn field<'a>(breach: &'a TextBreach, key: &str) -> Option<&'a Value> {
    breach.fields.iter().find(|(name, _)| *name == key).map(|(_, held)| held)
}

/// A count the breach carries: a whole number the judge wrote from a `usize`.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the judge writes every count from a u32, so the double is a whole number in range"
)]
fn count(breach: &TextBreach, key: &str) -> u64 {
    match field(breach, key) {
        Some(Value::Number(n)) => *n as u64,
        _ => 0,
    }
}

/// A text the breach carries; a `null` element (a board's own tags) is `None`.
fn text(breach: &TextBreach, key: &str) -> Option<String> {
    match field(breach, key) {
        Some(Value::String(held)) => Some(held.clone()),
        _ => None,
    }
}

fn owned(breach: &TextBreach, key: &str) -> String {
    text(breach, key).unwrap_or_default()
}

/// The refusal of a state breaking `breach`, naming the document at `path`.
pub(crate) fn text_breach_refusal(breach: &TextBreach, path: &str) -> Refusal {
    let path = path.to_owned();
    match breach.shape {
        BreachShape::Run | BreachShape::Runs | BreachShape::Body => body_refusal(breach, path),
        BreachShape::NodeText
        | BreachShape::NodeLocation
        | BreachShape::Label
        | BreachShape::CommentMessage
        | BreachShape::AnchorQuote => value_refusal(breach, path),
        BreachShape::ContainerName
        | BreachShape::ThreadAnchor
        | BreachShape::OpenThreads
        | BreachShape::OpenChanges
        | BreachShape::ThreadMessages => annotation_refusal(breach, path),
        BreachShape::Tags => tags_refusal(breach, path),
        BreachShape::CanvasSize => canvas_refusal(breach, path),
        BreachShape::ContentRoot
        | BreachShape::UnattachedContainer
        | BreachShape::ReservedMapKey
        | BreachShape::RetiredShape
        | BreachShape::RetiredCommentPlane => structure_refusal(breach, path),
    }
}

/// `bodyRefusalMessage`: a run, runs, or a body past the limit.
fn body_refusal(breach: &TextBreach, path: String) -> Refusal {
    let chars = count(breach, "chars");
    match breach.shape {
        BreachShape::Run => {
            Refusal::MarkdownRunDocument { chars, max_chars: MARKDOWN_MAX_CHARS, path }
        }
        BreachShape::Runs => Refusal::MarkdownRunsDocument {
            chars,
            max_chars: MARKDOWN_MAX_CHARS,
            path,
            runs: count(breach, "runs"),
        },
        _ => Refusal::MarkdownBodyDocument { chars, limit: phrase::MARKDOWN.to_owned(), path },
    }
}

/// A text a node, an edge, a message or an anchor carries, past its bound.
fn value_refusal(breach: &TextBreach, path: String) -> Refusal {
    let chars = count(breach, "chars");
    match breach.shape {
        BreachShape::NodeText => Refusal::NodeTextTooLargeDocument {
            chars,
            limit: phrase::NODE_TEXT.to_owned(),
            node_id: owned(breach, "nodeId"),
            path,
        },
        BreachShape::NodeLocation => Refusal::NodeLocationTooLargeDocument {
            chars,
            limit: phrase::NODE_LOCATION.to_owned(),
            node_id: owned(breach, "nodeId"),
            path,
        },
        BreachShape::Label => Refusal::LabelTooLargeDocument {
            chars,
            element_id: owned(breach, "elementId"),
            limit: phrase::LABEL.to_owned(),
            path,
        },
        BreachShape::CommentMessage => Refusal::CommentMessageTooLargeDocument {
            chars,
            limit: phrase::COMMENT_MESSAGE.to_owned(),
            message_id: owned(breach, "messageId"),
            path,
        },
        _ => Refusal::AnchorQuoteTooLongDocument {
            chars,
            element_id: owned(breach, "elementId"),
            limit: phrase::TEXT_ANCHOR_QUOTE.to_owned(),
            path,
        },
    }
}

/// The annotation layer's counts, and a container's name, past their bounds.
fn annotation_refusal(breach: &TextBreach, path: String) -> Refusal {
    let held = count(breach, "count");
    match breach.shape {
        BreachShape::ContainerName => Refusal::ContainerNameTooLongDocument {
            chars: count(breach, "chars"),
            limit: phrase::CONTAINER_NAME.to_owned(),
            path,
        },
        BreachShape::ThreadAnchor => Refusal::CommentAnchorTooLargeDocument {
            count: held,
            limit: phrase::ANCHOR_NODES.to_owned(),
            path,
            thread_id: owned(breach, "threadId"),
        },
        BreachShape::OpenThreads => Refusal::TooManyOpenThreadsDocument {
            count: held,
            limit: phrase::OPEN_THREADS.to_owned(),
            path,
        },
        BreachShape::OpenChanges => Refusal::TooManyOpenChangesDocument {
            count: held,
            limit: phrase::OPEN_CHANGES.to_owned(),
            path,
        },
        _ => Refusal::TooManyThreadMessagesDocument {
            count: held,
            limit: phrase::THREAD_MESSAGES.to_owned(),
            path,
        },
    }
}

/// What a document's history left standing that no document may hold.
fn structure_refusal(breach: &TextBreach, path: String) -> Refusal {
    match breach.shape {
        BreachShape::ContentRoot => {
            Refusal::ContentRootKindDocument { key: owned(breach, "key"), path }
        }
        BreachShape::UnattachedContainer => {
            Refusal::UnattachedContainerDocument { container: owned(breach, "container"), path }
        }
        BreachShape::ReservedMapKey => {
            Refusal::ReservedMapKeyDocument { container: owned(breach, "container"), path }
        }
        BreachShape::RetiredShape => {
            Refusal::RetiredShapeWrittenDocument { found: owned(breach, "found"), path }
        }
        _ => Refusal::RetiredCommentPlaneWrittenDocument { path, rows: count(breach, "rows") },
    }
}

/// `tagsRefusalMessage`: a count or a length, on the board or on one element.
fn tags_refusal(breach: &TextBreach, path: String) -> Refusal {
    let amount = count(breach, "amount");
    let element = text(breach, "elementId");
    let by_count = text(breach, "measure").as_deref() == Some("count");
    match (by_count, element) {
        (true, None) => {
            Refusal::TagsCountBoardDocument { amount, limit: phrase::TAG_COUNT.to_owned(), path }
        }
        (true, Some(element_id)) => Refusal::TagsCountElementDocument {
            amount,
            element_id,
            limit: phrase::TAG_COUNT.to_owned(),
            path,
        },
        (false, None) => {
            Refusal::TagsLengthBoardDocument { amount, limit: phrase::TAG_LENGTH.to_owned(), path }
        }
        (false, Some(element_id)) => Refusal::TagsLengthElementDocument {
            amount,
            element_id,
            limit: phrase::TAG_LENGTH.to_owned(),
            path,
        },
    }
}

/// `CanvasTooLargeError`: nodes, or edges and lines together.
fn canvas_refusal(breach: &TextBreach, path: String) -> Refusal {
    let count = count(breach, "count");
    if text(breach, "measure").as_deref() == Some("nodes") {
        Refusal::CanvasTooLargeNodesDocument { count, limit: phrase::CANVAS_NODES.to_owned(), path }
    } else {
        Refusal::CanvasTooLargeEdgesAndLinesDocument {
            count,
            limit: phrase::CANVAS_EDGES_AND_LINES.to_owned(),
            path,
        }
    }
}

#[cfg(test)]
mod tests;
