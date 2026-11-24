//! What a workspace adds to a facet listing (`createFacetListTool` with a
//! `workspaceId`): the stencils its library document declares, composed
//! beside the deployment's as `workspace.<name>`; the tags its documents
//! already use, counted by what carries them; and the keys its tag library
//! declares. One listing of the workspace serves all three.

use whiteboard_api_contracts::Refusal;
use whiteboard_facet_engine::partition::compose_library;
use whiteboard_facet_engine::plugin_manifest::AssetKind;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::canvas_value::canvas_of;
use whiteboard_model::crdt::QueryName;
use whiteboard_model::{Map, Value};
use whiteboard_plugin_visual::stencil_library::{STENCIL_LIBRARY_PATH, read_stencil_library};
use whiteboard_plugin_visual::tag_library::{TAG_LIBRARY_PATH, read_tag_library};
use whiteboard_ports::PortError;
use whiteboard_reference_graph::{
    DocumentContent, LoadedContent, TagBearer, TagInUse, tag_bearers_of, tags_in_use,
};
use whiteboard_workspace_index::{DocumentEntry, WorkspaceRecord, list_documents};

use super::{AssetEntry, DeclaredKey, DeclaredValue};
use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted};

/// A workspace's own vocabulary.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Vocabulary {
    /// The library's stencils the registry accepts, in name order.
    pub(super) stencils: Vec<AssetEntry>,
    pub(super) tags: Vec<TagInUse>,
    pub(super) tag_library: Vec<DeclaredKey>,
}

/// Why a workspace's vocabulary is not answered.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Unread {
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

pub(super) fn vocabulary(
    record: &WorkspaceRecord,
    registry: &Registry,
) -> Result<Vocabulary, Unread> {
    // A stamp no `Date` holds throws from `toISOString` there.
    let entries = list_documents(record)
        .map_err(|_| Unread::Refused(Refusal::from(&PortError::InvalidTime)))?;
    let library =
        read_stencil_library(&facets_at(record, &entries, STENCIL_LIBRARY_PATH)?, registry);
    let kept = compose_library(registry, &library).kept;
    let stencils = kept.into_iter().map(|id| stencil(id, &library)).collect();
    let mut bearers = Vec::new();
    for entry in &entries {
        bearers.extend(bearers_of(Hosted { record, document_id: &entry.document_id }, entry)?);
    }
    let declared = read_tag_library(&facets_at(record, &entries, TAG_LIBRARY_PATH)?, registry);
    let tag_library = declared.into_iter().map(|(key, held)| declared_key(key, &held)).collect();
    Ok(Vocabulary { stencils, tags: tags_in_use(&bearers), tag_library })
}

/// The facets of the document at `path`, or none when the workspace holds
/// no document there.
fn facets_at(
    record: &WorkspaceRecord,
    entries: &[DocumentEntry],
    path: &str,
) -> Result<Value, Unread> {
    let Some(entry) = entries.iter().find(|entry| entry.path == path) else {
        return Ok(Value::Null);
    };
    Ok(Hosted { record, document_id: &entry.document_id }.read(QueryName::Facets, &[])?)
}

/// A kept stencil, named by what its library calls it.
fn stencil(id: String, library: &Map) -> AssetEntry {
    let name = id.split_once('.').map_or("", |(_, name)| name);
    let declared = library.iter().find(|(held, _)| held == name).map(|(_, stencil)| stencil);
    let display_name = match declared.and_then(|stencil| field(stencil, "displayName")) {
        Some(Value::String(shown)) => Some(shown.clone()),
        _ => None,
    };
    let namespace = id.split_once('.').map_or("", |(namespace, _)| namespace).to_owned();
    AssetEntry { id, kind: AssetKind::Stencils, namespace, display_name }
}

fn field<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, held)| held),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    match field(value, key) {
        Some(Value::String(held)) => Some(held.clone()),
        _ => None,
    }
}

/// What carries a tag in one document, read as the reference graph's cache
/// loads it: its content with a note's own tags, the index row's kind asked
/// for a document that records none.
fn bearers_of(hosted: Hosted<'_>, entry: &DocumentEntry) -> Result<Vec<TagBearer>, Unread> {
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
    Ok(tag_bearers_of(&LoadedContent { content, tags: tags.as_deref() }))
}

/// A declared key as an answer: arrays rather than the record it is stored
/// as, an absent field for what was not declared.
fn declared_key(key: String, declaration: &Value) -> DeclaredKey {
    let values = match field(declaration, "values") {
        Some(Value::Map(values)) => Some(
            values
                .iter()
                .map(|(value, held)| DeclaredValue {
                    value: value.clone(),
                    color: text(held, "color"),
                    description: text(held, "description"),
                })
                .collect(),
        ),
        _ => None,
    };
    let exclusive = match field(declaration, "exclusive") {
        Some(Value::Bool(flag)) => Some(*flag),
        _ => None,
    };
    DeclaredKey { key, description: text(declaration, "description"), exclusive, values }
}
