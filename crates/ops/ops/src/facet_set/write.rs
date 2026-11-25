//! What `wb_facet_set` writes to one document, by the site it lands on: an
//! element of the board, the board's own envelope, or the document's
//! frontmatter.

use whiteboard_api_contracts::Refusal;
use whiteboard_model::crdt::{Write, WriterName};
use whiteboard_model::{Map, Value, enumeration_order};
use whiteboard_ports::Touched;
use whiteboard_workspace_index::WorkspaceRecord;

use crate::document_save::{Declined, save_batch};

use super::read::{Doc, Halt, Kind, elements, id_of, member};
use super::tags::{TagEdit, tags_of};
use super::{FacetSetInput, FacetSetPending, UpdatedDocument};

/// What a write told the pages watching the board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Activity {
    pub(super) touched: Touched,
    pub(super) summary: &'static str,
}

/// One document's write, decided and not yet applied.
pub(super) struct Change {
    pub(super) updated: UpdatedDocument,
    pub(super) batch: Vec<Write>,
    pub(super) activity: Option<Activity>,
}

/// The payload as the call judged it: sets and deletions, and the tags in the
/// form applying them reads.
pub(super) struct Payload<'a> {
    pub(super) input: &'a FacetSetInput,
    pub(super) edit: Option<&'a TagEdit>,
    pub(super) sets: &'a [(String, Value)],
    pub(super) deletions: &'a [String],
}

/// Which collection of the board an element write lands in.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Collection {
    Nodes,
    Edges,
}

impl Collection {
    const fn name(self) -> &'static str {
        match self {
            Self::Nodes => "nodes",
            Self::Edges => "edges",
        }
    }

    /// What a markdown document is told when asked for an element.
    fn mismatch(self, document_id: &str, kind: Kind) -> Refusal {
        let detail = match self {
            Self::Nodes => {
                "Node-target facets live on a spatial document's node. Omit nodeId to set facets on a markdown document."
            }
            Self::Edges => {
                "Edge-target facets live on a spatial document's edge. Omit edgeId to set facets on a markdown document."
            }
        };
        Refusal::DocumentKindMismatch {
            document_id: document_id.to_owned(),
            kind: kind.name().to_owned(),
            detail: detail.to_owned(),
        }
    }

    fn not_found(self, document_id: &str, id: &str) -> Refusal {
        let document_id = document_id.to_owned();
        match self {
            Self::Nodes => Refusal::NodeNotFound { document_id, node_id: id.to_owned() },
            Self::Edges => Refusal::EdgeNotFound { document_id, edge_id: id.to_owned() },
        }
    }
}

/// The stored facets with the sets laid over them and the deletions taken
/// out, in the order a JavaScript spread keeps: a key already there stays
/// where it was, a new one follows.
fn merged(stored: &[(String, Value)], payload: &Payload<'_>) -> Map {
    let mut out: Map = stored.to_vec();
    for (key, value) in payload.sets {
        match out.iter_mut().find(|(held, _)| held == key) {
            Some(entry) => entry.1 = value.clone(),
            None => out.push((key.clone(), value.clone())),
        }
    }
    out.retain(|(key, _)| !payload.deletions.contains(key));
    out
}

/// Whether the answer would spell what is stored in an order only npm loro's
/// hash map knows: two stored keys that survive (their order among each
/// other), or a kept payload holding an object of several keys. A native
/// build reads both in its own order, which the TypeScript's need not equal,
/// so such a write is left pending rather than answered in a guess.
fn order_unknown(stored: &[(String, Value)], payload: &Payload<'_>) -> bool {
    let surviving: Vec<_> =
        stored.iter().filter(|(key, _)| !payload.deletions.contains(key)).collect();
    let replaced = |key: &String| payload.sets.iter().any(|(set, _)| set == key);
    surviving.len() > 1
        || surviving.iter().any(|(key, value)| !replaced(key) && holds_wide_map(value))
}

/// Whether an object of two keys or more is anywhere in the value.
fn holds_wide_map(value: &Value) -> bool {
    match value {
        Value::Map(entries) => {
            entries.len() > 1 || entries.iter().any(|(_, held)| holds_wide_map(held))
        }
        Value::Seq(items) => items.iter().any(holds_wide_map),
        _ => false,
    }
}

/// [`merged`] over what is stored, or the call left pending when the order of
/// what is stored is unknown ([`order_unknown`]).
fn merged_known(stored: &[(String, Value)], payload: &Payload<'_>) -> Result<Map, Halt> {
    if order_unknown(stored, payload) {
        return Err(Halt::Pending(FacetSetPending::StoredOrder));
    }
    Ok(merged(stored, payload))
}

/// `entries` with the members `names` leave out.
fn without(entries: &[(String, Value)], names: &[&str]) -> Map {
    entries.iter().filter(|(key, _)| !names.contains(&key.as_str())).cloned().collect()
}

/// An empty tag set is no field at all.
fn with_tags(entries: &mut Map, tags: Option<&[String]>) {
    if let Some(tags) = tags.filter(|tags| !tags.is_empty()) {
        entries.push((
            "tags".to_owned(),
            Value::Seq(tags.iter().cloned().map(Value::String).collect()),
        ));
    }
}

/// Canonical emptiness: an empty bucket disappears rather than being stored
/// as `{}`, so an element that set a facet and cleared it is identical to one
/// that never had it.
fn with_facets(entries: &mut Map, facets: &Map) {
    if !facets.is_empty() {
        entries.push(("facets".to_owned(), Value::Map(facets.clone())));
    }
}

/// The answer's facets, in the order JavaScript enumerates them.
fn shown(facets: Map) -> Map {
    match enumeration_order(Value::Map(facets)) {
        Value::Map(entries) => entries,
        _ => Map::new(),
    }
}

fn stored_facets(element: &Map) -> Map {
    match member(element, "facets") {
        Some(Value::Map(held)) => held.clone(),
        _ => Map::new(),
    }
}

fn reconcile(prev: &Map, next: Map) -> Write {
    Write {
        op: WriterName::ReconcileSpatialCanvas,
        args: Value::Map(vec![
            ("prev".to_owned(), Value::Map(prev.clone())),
            ("next".to_owned(), Value::Map(next)),
        ]),
    }
}

fn updated(document_id: &str, facets: Map, tags: Option<Vec<String>>) -> UpdatedDocument {
    UpdatedDocument { document_id: document_id.to_owned(), facets: shown(facets), tags }
}

/// The write to one NODE or one EDGE. A document that states no kind has no
/// canvas, so the element cannot exist: that is reported rather than a kind
/// being fabricated for a mismatch.
pub(super) fn element(
    payload: &Payload<'_>,
    doc: Doc<'_>,
    kind: Option<Kind>,
    which: Collection,
    id: &str,
) -> Result<Change, Halt> {
    let Some(kind) = kind else { return Err(which.not_found(doc.id, id).into()) };
    if kind != Kind::Spatial {
        return Err(which.mismatch(doc.id, kind).into());
    }
    let canvas = doc.canvas()?;
    let members = elements(&canvas, which.name());
    let found = *members
        .iter()
        .find(|candidate| id_of(candidate) == Some(id))
        .ok_or_else(|| which.not_found(doc.id, id))?;
    let facets = merged_known(&stored_facets(found), payload)?;
    let stored = tags_of(member(found, "tags"));
    let tags = payload.edit.map(|edit| edit.apply(stored.as_deref()));
    let mut next = without(found, &["facets", "tags"]);
    with_facets(&mut next, &facets);
    with_tags(&mut next, tags.as_deref().or(stored.as_deref()));
    let replaced = members
        .iter()
        .map(|candidate| {
            Value::Map(if id_of(candidate) == Some(id) {
                next.clone()
            } else {
                (*candidate).clone()
            })
        })
        .collect();
    let changed = replace(&canvas, which.name(), Value::Seq(replaced));
    let mut touched = Touched::default();
    let ids = vec![id.to_owned()];
    match which {
        Collection::Nodes => touched.nodes = ids,
        Collection::Edges => touched.edges = ids,
    }
    Ok(Change {
        updated: updated(doc.id, facets, tags),
        batch: vec![reconcile(&canvas, changed)],
        activity: Some(Activity { touched, summary: "changed 1" }),
    })
}

/// `entries` with the member `name` set to `value`, where it was.
fn replace(entries: &Map, name: &str, value: Value) -> Map {
    let mut out: Map = entries.clone();
    match out.iter_mut().find(|(held, _)| held == name) {
        Some(entry) => entry.1 = value,
        None => out.push((name.to_owned(), value)),
    }
    out
}

/// A rename reaches every node and edge too: it is vocabulary maintenance
/// over the document, not a write to the board alone.
fn renamed(element: &Map, renames: Option<&TagEdit>) -> Value {
    let (Some(renames), Some(held)) = (renames, tags_of(member(element, "tags"))) else {
        return Value::Map(element.clone());
    };
    let mut next = without(element, &["tags"]);
    with_tags(&mut next, Some(&renames.apply(Some(&held))));
    Value::Map(next)
}

/// The write to the board's own envelope.
pub(super) fn canvas(
    payload: &Payload<'_>,
    doc: Doc<'_>,
    kind: Option<Kind>,
) -> Result<Change, Halt> {
    let canvas = doc.canvas()?;
    let facets = merged_known(&stored_facets(&canvas), payload)?;
    let stored = tags_of(member(&canvas, "tags"));
    let tags = payload.edit.map(|edit| edit.apply(stored.as_deref()));
    let renames = payload.edit.and_then(TagEdit::renames_only);
    let each = |collection: &str| {
        Value::Seq(
            elements(&canvas, collection)
                .iter()
                .map(|held| renamed(held, renames.as_ref()))
                .collect(),
        )
    };
    let mut next = without(&canvas, &["facets", "tags"]);
    next = replace(&next, "nodes", each("nodes"));
    next = replace(&next, "edges", each("edges"));
    with_facets(&mut next, &facets);
    with_tags(&mut next, tags.as_deref().or(stored.as_deref()));
    // The envelope is no one element, so the chip shows and nothing is
    // outlined.
    let activity = (kind == Some(Kind::Spatial))
        .then(|| Activity { touched: Touched::default(), summary: "changed the canvas" });
    Ok(Change {
        updated: updated(doc.id, facets, tags),
        batch: vec![reconcile(&canvas, next)],
        activity,
    })
}

/// The write to the document's OKF frontmatter.
pub(super) fn document(payload: &Payload<'_>, doc: Doc<'_>) -> Result<Change, Halt> {
    let stored = doc.facets()?;
    let facets = merged_known(&stored, payload)?;
    let mut batch = Vec::new();
    // Applied against what was read, so an entry this build's reader dropped
    // (a newer client's facet) is left alone rather than resynced away.
    if payload.input.facets.is_some() {
        batch.push(Write {
            op: WriterName::ReconcileFacets,
            args: Value::Map(vec![
                ("prev".to_owned(), Value::Map(stored)),
                ("next".to_owned(), Value::Map(facets.clone())),
            ]),
        });
    }
    let mut tags = None;
    if let Some(edit) = payload.edit {
        let core = doc
            .core()?
            .ok_or_else(|| Refusal::DocumentHasNoFrontmatter { document_id: doc.id.to_owned() })?;
        let after = edit.apply(tags_of(member(&core, "tags")).as_deref());
        let mut next = without(&core, &["tags"]);
        with_tags(&mut next, Some(&after));
        batch.push(Write {
            op: WriterName::ReconcileCoreFacets,
            args: Value::Map(vec![
                ("prev".to_owned(), Value::Map(core)),
                ("next".to_owned(), Value::Map(next)),
            ]),
        });
        tags = Some(after);
    }
    Ok(Change { updated: updated(doc.id, facets, tags), batch, activity: None })
}

/// The batch kept as the content the document's node holds: the operations to
/// store, none when nothing moved.
pub(super) fn apply(
    record: &WorkspaceRecord,
    peer: u64,
    now_ms: f64,
    document_id: &str,
    batch: &[Write],
) -> Result<Option<Vec<u8>>, FacetSetPending> {
    save_batch(record, peer, now_ms, document_id, batch)
        .map_err(|Declined| FacetSetPending::Declined)
}

#[cfg(test)]
mod tests;
