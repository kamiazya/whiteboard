//! The refusals that need the WORKSPACE read, all taken before the first
//! document is written: every document is confirmed to be in it, a kind that
//! cannot hold the write is refused, so is a locked element, and then a tag
//! set grown past the bound or one its tag library forbids.

use whiteboard_api_contracts::Refusal;
use whiteboard_facet_engine::plugin_manifest::FacetTarget;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::crdt::QueryName;
use whiteboard_model::{Map, Value};
use whiteboard_plugin_visual::tag_library::{TAG_LIBRARY_PATH, read_tag_library};
use whiteboard_ports::PortError;
use whiteboard_workspace_index::{WorkspaceRecord, list_documents};

use super::read::{Doc, Halt, Kind, elements, id_of, member};
use super::tags::{Objection, TAGS_PER_ELEMENT_MAX, TagEdit, objection, tags_of};
use super::{FacetSetInput, Site, site_of};
use crate::document_resolve::resolve_in;

const SPATIAL_HAS_NO_FRONTMATTER: &str = "Facets are OKF frontmatter, and a JSON Canvas document has none to hold them. Pass target: 'canvas' for canvas-target facets (a theme, edge routing), nodeId for node-target facets, set them on the markdown document this one refers to, or write its content with `wb_workspace_edit`'s `document.set` op.";
const MARKDOWN_HAS_NO_CANVAS: &str = "Canvas-target facets live on a spatial document's canvas envelope. Omit target to set facets on a markdown document.";

/// The phases, in the order they refuse.
pub(super) fn before_any_write(
    record: &WorkspaceRecord,
    registry: &Registry,
    input: &FacetSetInput,
    edit: Option<&TagEdit>,
) -> Result<(), Halt> {
    for document_id in &input.document_ids {
        resolve_in(record, &input.workspace_id, document_id)?;
    }
    kinds(record, input)?;
    locked(record, input, edit)?;
    let Some(edit) = edit else { return Ok(()) };
    let library = tag_library(record, registry)?;
    let judges = !library.is_empty();
    // Only an add can grow a set; a batch with nothing to judge loads nothing.
    if !judges && !edit.has_adds() {
        return Ok(());
    }
    for document_id in &input.document_ids {
        let doc = Doc { record, id: document_id };
        for set in tag_sets_after(doc, input, edit)? {
            if set.tags.len() > TAGS_PER_ELEMENT_MAX && set.tags.len() > set.before {
                let count = u64::try_from(set.tags.len()).unwrap_or(u64::MAX);
                return Err(Refusal::TooManyTagsOnElement { count, what: set.what }.into());
            }
            if judges && let Some(found) = objection(&library, &set.tags) {
                return Err(library_refusal(found, set.what).into());
            }
        }
    }
    Ok(())
}

/// Refuses a batch naming a document whose kind cannot hold this write. Only
/// the document and canvas sites are judged here: an element write names one
/// document, so it refuses before any write by construction, and it keeps its
/// own not-found-before-kind order.
fn kinds(record: &WorkspaceRecord, input: &FacetSetInput) -> Result<(), Halt> {
    if input.node_id.is_some() || input.edge_id.is_some() {
        return Ok(());
    }
    if input.facets.is_none() && input.target != Some(FacetTarget::Canvas) {
        return Ok(());
    }
    for document_id in &input.document_ids {
        let kind = Doc { record, id: document_id }.kind()?;
        let detail = match kind {
            // Its TAGS are another matter: a board is as taggable as a note,
            // and `target` is not needed to say so.
            Some(Kind::Spatial)
                if input.target != Some(FacetTarget::Canvas) && input.facets.is_some() =>
            {
                SPATIAL_HAS_NO_FRONTMATTER
            }
            Some(Kind::Markdown) if input.target == Some(FacetTarget::Canvas) => {
                MARKDOWN_HAS_NO_CANVAS
            }
            _ => continue,
        };
        return Err(Refusal::DocumentKindMismatch {
            document_id: document_id.clone(),
            kind: kind.map_or("", Kind::name).to_owned(),
            detail: detail.to_owned(),
        }
        .into());
    }
    Ok(())
}

/// Refuses a write that would change a locked node or edge: the element
/// named, for any write, and every locked element a board-wide rename would
/// rewrite. Read only for a write that can reach an element.
fn locked(
    record: &WorkspaceRecord,
    input: &FacetSetInput,
    edit: Option<&TagEdit>,
) -> Result<(), Halt> {
    let renames = edit.is_some_and(TagEdit::renames_any);
    if input.node_id.is_none() && input.edge_id.is_none() && !renames {
        return Ok(());
    }
    for document_id in &input.document_ids {
        let doc = Doc { record, id: document_id };
        if doc.kind()? != Some(Kind::Markdown) {
            locked_in(doc, input, edit)?;
        }
    }
    Ok(())
}

fn locked_in(doc: Doc<'_>, input: &FacetSetInput, edit: Option<&TagEdit>) -> Result<(), Halt> {
    let node_locks = doc.locks(QueryName::NodeLocks)?;
    let edge_locks = doc.locks(QueryName::EdgeLocks)?;
    if let Some(id) = &input.node_id {
        return if node_locks.contains(id) {
            Err(Refusal::NodeLockedNothingWritten { id: id.clone() }.into())
        } else {
            Ok(())
        };
    }
    if let Some(id) = &input.edge_id {
        return if edge_locks.contains(id) {
            Err(Refusal::EdgeLockedNothingWritten { id: id.clone() }.into())
        } else {
            Ok(())
        };
    }
    // A board-wide rename: `target: 'canvas'` or a spatial document, the same
    // site test the write itself applies.
    let canvas = doc.canvas()?;
    let reached = |element: &Map| {
        edit.is_some_and(|edit| edit.reaches(tags_of(member(element, "tags")).as_deref()))
    };
    let held = |collection: &str, locks: &[String]| {
        elements(&canvas, collection)
            .into_iter()
            .find(|element| {
                id_of(element).is_some_and(|id| locks.iter().any(|l| l == id)) && reached(element)
            })
            .and_then(id_of)
            .map(str::to_owned)
    };
    if let Some(id) = held("nodes", &node_locks) {
        return Err(Refusal::NodeLockedNothingWritten { id }.into());
    }
    if let Some(id) = held("edges", &edge_locks) {
        return Err(Refusal::EdgeLockedNothingWritten { id }.into());
    }
    Ok(())
}

/// What the workspace's tag library declares, or nothing: for a workspace
/// without one, and for a malformed one (a drawing must stay readable when a
/// document elsewhere is wrong).
fn tag_library(record: &WorkspaceRecord, registry: &Registry) -> Result<Map, Halt> {
    let entries = list_documents(record).map_err(|_| Refusal::from(&PortError::InvalidTime))?;
    let Some(entry) = entries.iter().find(|entry| entry.path == TAG_LIBRARY_PATH) else {
        return Ok(Map::new());
    };
    let facets = Doc { record, id: &entry.document_id }.facets()?;
    Ok(read_tag_library(&Value::Map(facets), registry))
}

fn library_refusal(found: Objection, what: String) -> Refusal {
    let library_path = TAG_LIBRARY_PATH.to_owned();
    match found {
        Objection::Undeclared { tag, key, admitted } => {
            Refusal::TagNotAdmitted { tag, what, library_path, key, admitted }
        }
        Objection::Exclusive { key, carried } => {
            Refusal::TagExclusive { key, library_path, what, carried }
        }
    }
}

/// One tag set a write would leave behind, named for a refusal.
struct TagSet {
    what: String,
    before: usize,
    tags: Vec<String>,
}

fn tag_set(what: String, current: Option<&[String]>, edit: &TagEdit) -> TagSet {
    TagSet { what, before: current.map_or(0, <[String]>::len), tags: edit.apply(current) }
}

/// Every tag set a write to `doc` would leave behind: the node's, the edge's,
/// the board's and every node's and edge's a rename reaches, or the note's
/// own. A target the write cannot reach (no such node, the wrong kind)
/// answers nothing here and leaves the write to refuse it by name.
fn tag_sets_after(
    doc: Doc<'_>,
    input: &FacetSetInput,
    edit: &TagEdit,
) -> Result<Vec<TagSet>, Halt> {
    let kind = doc.kind()?;
    Ok(match site_of(input, kind) {
        Site::Node | Site::Edge if kind == Some(Kind::Spatial) => {
            at_element(&doc.canvas()?, input, edit)
        }
        Site::Node | Site::Edge => Vec::new(),
        Site::Canvas if kind == Some(Kind::Markdown) => Vec::new(),
        Site::Canvas => at_canvas(&doc.canvas()?, edit),
        Site::Document => match doc.core()? {
            None => Vec::new(),
            Some(core) => {
                let held = tags_of(member(&core, "tags"));
                vec![tag_set(format!("document {}", doc.id), held.as_deref(), edit)]
            }
        },
    })
}

fn at_element(canvas: &Map, input: &FacetSetInput, edit: &TagEdit) -> Vec<TagSet> {
    let (collection, id, noun) = match (&input.node_id, &input.edge_id) {
        (Some(id), _) => ("nodes", id, "node"),
        (None, Some(id)) => ("edges", id, "edge"),
        (None, None) => return Vec::new(),
    };
    let Some(element) = elements(canvas, collection).into_iter().find(|e| id_of(e) == Some(id))
    else {
        return Vec::new();
    };
    let held = tags_of(member(element, "tags"));
    vec![tag_set(format!("{noun} {id}"), held.as_deref(), edit)]
}

/// A rename reaches every node and edge too: vocabulary maintenance over the
/// document, not a write to the board alone, which is what the write does and
/// therefore what this must refuse for.
fn at_canvas(canvas: &Map, edit: &TagEdit) -> Vec<TagSet> {
    let held = tags_of(member(canvas, "tags"));
    let mut sets = vec![tag_set("the board".to_owned(), held.as_deref(), edit)];
    let Some(renames) = edit.renames_only() else { return sets };
    for (collection, noun) in [("nodes", "node"), ("edges", "edge")] {
        for element in elements(canvas, collection) {
            let (Some(id), Some(tags)) = (id_of(element), tags_of(member(element, "tags"))) else {
                continue;
            };
            sets.push(tag_set(format!("{noun} {id}"), Some(&tags), &renames));
        }
    }
    sets
}
