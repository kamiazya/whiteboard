//! The proposal layer a document stores beside its threads: a `proposals` map
//! whose every value is a map of its own holding the batch's author and time
//! and a nested map of its changes, each change a plain value under its own id
//! (ADR-0029).
//!
//! A change is one anchored edit with the value it assumed its anchor held and
//! a verdict. The model's `proposedChangeSchema` is a union closed on `op`,
//! every arm strict, and a record the schema refuses costs that record alone.

use crate::anchor::text_anchor;
use crate::annotations::{
    accepted_entries, actor, by_code_unit, child_map, optional_field, timestamp,
};
use crate::content::map_of;
use crate::patch::{edge_patch, emit_patch, line_patch, node_patch};
use crate::plain::{object_of, plain};
use crate::stored::{
    self, field, is_text, map_of as value_map, names_only, node_id, required, text,
};
use loro::{LoroDoc, LoroMap, LoroMapValue, LoroValue};
use whiteboard_model::Value;

const PROPOSALS_KEY: &str = "proposals";
const CHANGES_KEY: &str = "changes";

/// One proposal the schema accepted: the batch's own fields and the changes it
/// accepted, ordered by id.
pub(crate) struct Proposal {
    id: String,
    author: Option<LoroValue>,
    created_at: Option<LoroValue>,
    pub(crate) changes: Vec<LoroValue>,
}

fn status(value: &LoroValue) -> bool {
    matches!(text(value), Some("open" | "adopted" | "dismissed"))
}

/// The arm's own keys beside the three every change carries.
fn keyed(change: &LoroMapValue, own: &[&str]) -> bool {
    let mut keys = vec!["id", "status", "op"];
    keys.extend_from_slice(own);
    names_only(change, &keys)
        && required(change, "id", node_id)
        && required(change, "status", status)
}

fn adding(change: &LoroMapValue, key: &str, record: fn(&LoroValue) -> bool) -> bool {
    keyed(change, &[key]) && required(change, key, record)
}

fn removing(change: &LoroMapValue, id_key: &str, record: fn(&LoroValue) -> bool) -> bool {
    keyed(change, &[id_key, "assumed"])
        && required(change, id_key, node_id)
        && required(change, "assumed", record)
}

/// A prior may name only fields the change itself sets.
fn declares_no_prior_outside_its_change(change: &LoroMapValue) -> bool {
    let named = |key: &str| field(change, key).and_then(value_map);
    match (named("patch"), named("assumed")) {
        (Some(patch), Some(assumed)) => assumed.iter().all(|(key, _)| patch.contains_key(key)),
        _ => false,
    }
}

fn patching(change: &LoroMapValue, id_key: &str, patch: fn(&LoroValue) -> bool) -> bool {
    keyed(change, &[id_key, "patch", "assumed"])
        && required(change, id_key, node_id)
        && required(change, "patch", patch)
        && required(change, "assumed", patch)
        && declares_no_prior_outside_its_change(change)
}

fn replacing(change: &LoroMapValue) -> bool {
    keyed(change, &["anchor", "text", "assumed"])
        && required(change, "anchor", text_anchor)
        && required(change, "text", is_text)
        && required(change, "assumed", is_text)
}

/// Whether `proposedChangeSchema` accepts the value.
pub(crate) fn change_valid(value: &LoroValue) -> bool {
    let Some(change) = value_map(value) else { return false };
    match field(change, "op").and_then(text) {
        Some("node.add") => adding(change, "node", stored::node),
        Some("node.patch") => patching(change, "nodeId", node_patch),
        Some("node.remove") => removing(change, "nodeId", stored::node),
        Some("edge.add") => adding(change, "edge", stored::edge),
        Some("edge.patch") => patching(change, "edgeId", edge_patch),
        Some("edge.remove") => removing(change, "edgeId", stored::edge),
        Some("line.add") => adding(change, "line", stored::line),
        Some("line.patch") => patching(change, "lineId", line_patch),
        Some("line.remove") => removing(change, "lineId", stored::line),
        Some("body.replace") => replacing(change),
        _ => false,
    }
}

/// A change the schema accepted, as the reader hands it back. `None` for a
/// payload the wire cannot write.
fn change_value(value: &LoroValue) -> Option<Value> {
    let change = value_map(value)?;
    let op = field(change, "op").and_then(text)?;
    let mut written = Vec::new();
    for (key, held) in change.iter() {
        let shown = match (op.rsplit('.').next(), key.as_str()) {
            (Some("add" | "remove"), "node" | "edge" | "line" | "assumed") => stored::emit(held)?,
            (Some("patch"), "patch" | "assumed") => emit_patch(held)?,
            _ => plain(held)?,
        };
        written.push((key.clone(), shown));
    }
    Some(object_of(written))
}

fn id_of(change: &LoroValue) -> &str {
    value_map(change).and_then(|c| field(c, "id")).and_then(text).unwrap_or_default()
}

/// One proposal by id, `None` when it is absent or the schema refuses it.
fn read_proposal(proposals: &LoroMap, id: &str) -> Option<Proposal> {
    let container = child_map(proposals.get(id))?;
    let author = optional_field(&container, "author").ok()?;
    let created_at = optional_field(&container, "createdAt").ok()?;
    let mut changes = child_map(container.get(CHANGES_KEY))
        .map(|held| accepted_entries(&held, change_valid))
        .unwrap_or_default();
    changes.sort_by(|a, b| by_code_unit(id_of(a), id_of(b)));
    let sound = !id.is_empty()
        && author.as_ref().is_none_or(actor)
        && created_at.as_ref().is_none_or(timestamp)
        && !changes.is_empty();
    sound.then(|| Proposal { id: id.to_owned(), author, created_at, changes })
}

/// Every proposal the document holds, ordered by id.
pub(crate) fn read_proposals(doc: &LoroDoc) -> Vec<Proposal> {
    let held = map_of(doc, PROPOSALS_KEY);
    let mut ids: Vec<String> = held.keys().map(|id| id.to_string()).collect();
    ids.sort_by(|a, b| by_code_unit(a, b));
    ids.iter().filter_map(|id| read_proposal(&held, id)).collect()
}

fn proposal_value(proposal: &Proposal) -> Option<Value> {
    let changes = proposal.changes.iter().map(change_value).collect::<Option<Vec<_>>>()?;
    let mut entries = vec![
        ("id".to_owned(), Value::String(proposal.id.clone())),
        ("changes".to_owned(), Value::Seq(changes)),
    ];
    for (key, held) in [("author", &proposal.author), ("createdAt", &proposal.created_at)] {
        if let Some(held) = held {
            entries.push((key.to_owned(), plain(held)?));
        }
    }
    Some(object_of(entries))
}

/// `proposals`: every proposal the document holds. `None` for a payload the
/// wire cannot write.
pub(crate) fn proposals(doc: &LoroDoc) -> Option<Value> {
    let written = read_proposals(doc).iter().map(proposal_value).collect::<Option<Vec<_>>>()?;
    Some(Value::Seq(written))
}
