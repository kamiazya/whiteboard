//! A document's content with its OKF core tags, read from the record that
//! hosts it as the reference graph's cache loads it: the content query under
//! the kind the index row records.

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::canvas_value::canvas_of;
use whiteboard_model::crdt::QueryName;
use whiteboard_reference_graph::{DocumentContent, LoadedContent};
use whiteboard_workspace_index::DocumentEntry;

use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted};

/// Why a document's content is not answered.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Unread {
    Refused(Refusal),
    /// A read this crate does not answer yet: one the record leaves to its
    /// caller, a stored shape an older version wrote, or a canvas the model
    /// does not read.
    Pending,
}

impl From<Fault> for Unread {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Stop(Stop::Refused(refusal)) => Self::Refused(refusal),
            Fault::Stop(Stop::Pending(_)) | Fault::Retired(_) => Self::Pending,
        }
    }
}

pub(crate) fn field<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, held)| held),
        _ => None,
    }
}

/// `answer` over one document's content and its own tags, the index row's
/// kind asked for a document that records none.
pub(crate) fn read_loaded<T>(
    hosted: Hosted<'_>,
    entry: &DocumentEntry,
    answer: impl FnOnce(&LoadedContent<'_>) -> T,
) -> Result<T, Unread> {
    let kind: Vec<(&str, Value)> =
        entry.kind.iter().map(|kind| ("kind", Value::String(kind.clone()))).collect();
    let read = hosted.read(QueryName::DocumentContentWithTags, &kind)?;
    let content = field(&read, "content").ok_or(Unread::Pending)?;
    let tags: Option<Vec<String>> = match field(&read, "tags") {
        Some(Value::Seq(tags)) => tags
            .iter()
            .map(|tag| match tag {
                Value::String(tag) => Some(tag.clone()),
                _ => None,
            })
            .collect(),
        _ => None,
    };
    let canvas = field(content, "canvas").map(|canvas| canvas_of(canvas).ok_or(Unread::Pending));
    let canvas = canvas.transpose()?;
    let content = match (&canvas, field(content, "body")) {
        (Some(canvas), _) => DocumentContent::Spatial(canvas),
        (None, Some(Value::String(body))) => DocumentContent::Markdown { body },
        _ => return Err(Unread::Pending),
    };
    Ok(answer(&LoadedContent { content, tags: tags.as_deref() }))
}
