//! Which documents the operations after a version removed from a workspace
//! record, each with the bytes a trash row needs to bring it back, read off the
//! record as it stood at that version (`documentsRemovedSince` in the
//! TypeScript's `removed-documents.ts`): a removed tree node cannot be revived,
//! and a shallow snapshot drops what it held.

use crate::index_writes::named_folders_above;
use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY};
use crate::record::WorkspaceRecord;
use crate::subtree::export_node;
use crate::walk::{Walked, walk_in};
use std::collections::BTreeSet;
use whiteboard_crdt::{
    LoroDoc, NodeId, Tree, VersionVector, commit, deep_value, delete_node, import_bytes, tree,
    tree_written_since,
};
use whiteboard_model::Value;

/// A document the operations removed, as a trash row records it.
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    pub document_id: String,
    /// Where it was before, for a listing a human reads.
    pub path: String,
    pub name: Option<String>,
    /// The named folders above it before, shallowest first.
    pub folder_names: Vec<(String, String)>,
    /// The state its subtree's bytes import to, tree ids written `counter@*`:
    /// the bytes carry the exporting replica's random peer, so two honest
    /// exports differ in them and agree in this.
    pub state: Value,
}

/// A document as a walk of the record before placed it, with the document
/// nearest above it on its parent chain.
struct Placed {
    document_id: String,
    path: String,
    name: Option<String>,
    node: NodeId,
    above: Option<String>,
}

/// The nearest document on `node`'s parent chain. Every node above a walked
/// one was walked, so the chain's documents are the ones `walked` holds.
fn document_above(held: &Tree, walked: &[Walked], node: NodeId) -> Option<String> {
    let mut at = held.parent(node);
    while let Some(up) = at {
        let found = walked.iter().find(|each| each.id == up);
        if let Some(Walked { read: NodeRead::Document(meta), .. }) = found {
            return Some(meta.document_id.clone());
        }
        at = held.parent(up);
    }
    None
}

fn placed_documents(doc: &LoroDoc) -> Vec<Placed> {
    tree(doc, WORKSPACE_TREE_KEY).map_or_else(Vec::new, |held| placed_in(&held))
}

fn placed_in(held: &Tree) -> Vec<Placed> {
    let walked = walk_in(held).0;
    walked
        .iter()
        .filter_map(|each| match &each.read {
            NodeRead::Document(meta) => Some(Placed {
                document_id: meta.document_id.clone(),
                path: each.path.clone(),
                name: meta.name.clone(),
                node: each.id,
                above: document_above(held, &walked, each.id),
            }),
            NodeRead::Folder { .. } => None,
        })
        .collect()
}

/// Whether `ancestor` is a proper ancestor path of `path`, segment by segment.
fn is_above(ancestor: &str, path: &str) -> bool {
    path.strip_prefix(ancestor).is_some_and(|rest| rest.starts_with('/'))
}

fn depth(path: &str) -> usize {
    path.split('/').count()
}

/// The path of the deepest evacuee above `path`: the first export to reach a
/// survivor there. Every evacuee at that path shares it, and the survivors
/// filed under it are cut before the first of them is exported.
fn deepest_evacuee_above<'a>(evacuees: &[&'a Placed], path: &str) -> Option<&'a str> {
    evacuees
        .iter()
        .map(|evacuee| evacuee.path.as_str())
        .filter(|above| is_above(above, path))
        .max_by_key(|above| depth(above))
}

/// `value` with every `counter@peer` string written `counter@*`.
fn mask_peers(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(masked(&text).unwrap_or(text)),
        Value::Seq(items) => Value::Seq(items.into_iter().map(mask_peers).collect()),
        Value::Map(entries) => {
            Value::Map(entries.into_iter().map(|(key, held)| (key, mask_peers(held))).collect())
        }
        other => other,
    }
}

fn masked(text: &str) -> Option<String> {
    let (counter, peer) = text.split_once('@')?;
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    (digits(counter) && digits(peer)).then(|| format!("{counter}@*"))
}

/// Why the removed documents are not answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotRemoved {
    /// Loro will not check the record out at the version, one a compaction
    /// left behind: npm loro-crdt throws a string there.
    Unreachable,
    /// An export was refused, or its bytes did not import.
    Unread,
}

/// The record as it stood at `since`, on a fork that may be cut: the scratch
/// copy the exports are trimmed on.
fn record_at(doc: &LoroDoc, since: &VersionVector) -> Result<LoroDoc, NotRemoved> {
    let before = doc.fork();
    before.checkout(&doc.vv_to_frontiers(since)).map_err(|_| NotRemoved::Unreachable)?;
    before.set_detached_editing(true);
    Ok(before)
}

/// Every document live at `since` and gone now, exported for the trash.
/// A removed document below another rides its ancestor's bytes, unless a
/// survivor sits between them.
///
/// # Errors
///
/// [`NotRemoved`] when the record cannot be read at `since` or an export is
/// refused.
pub fn documents_removed_since(
    doc: &LoroDoc,
    since: &VersionVector,
) -> Result<Vec<Removed>, NotRemoved> {
    if !tree_written_since(doc, WORKSPACE_TREE_KEY, since) {
        return Ok(Vec::new());
    }
    let alive: BTreeSet<String> =
        placed_documents(doc).into_iter().map(|each| each.document_id).collect();
    let before = record_at(doc, since)?;
    let was = placed_documents(&before);
    let gone = |id: &str| !alive.contains(id);
    let rides = |each: &Placed| each.above.as_deref().is_some_and(gone);
    let mut evacuees: Vec<&Placed> =
        was.iter().filter(|each| gone(&each.document_id) && !rides(each)).collect();
    if evacuees.is_empty() {
        return Ok(Vec::new());
    }
    let survivors: Vec<(&str, NodeId)> = was
        .iter()
        .filter(|each| !gone(&each.document_id))
        .filter_map(|each| Some((deepest_evacuee_above(&evacuees, &each.path)?, each.node)))
        .collect();
    let named = WorkspaceRecord::over(&before).folder_names();
    evacuees.sort_by_key(|each| std::cmp::Reverse(depth(&each.path)));
    let mut out = Vec::new();
    for evacuee in evacuees {
        // Live: a cut takes only survivors, and an evacuee below one is
        // deeper than the evacuee it is cut for, so exported before it.
        let state = cut(&before, &survivors, &evacuee.path)
            .and_then(|()| export_node(&before, evacuee.node))
            .ok()
            .and_then(|bytes| import_bytes(&bytes).ok())
            .ok_or(NotRemoved::Unread)?;
        out.push(Removed {
            document_id: evacuee.document_id.clone(),
            path: evacuee.path.clone(),
            name: evacuee.name.clone(),
            folder_names: named_folders_above(&named, &evacuee.path),
            state: mask_peers(deep_value(&state)),
        });
    }
    Ok(out)
}

/// Deletes from the scratch copy every survivor filed under the evacuee at
/// `path`, so its export leaves them out; one a delete already took is left be.
fn cut(
    before: &LoroDoc,
    survivors: &[(&str, NodeId)],
    path: &str,
) -> Result<(), whiteboard_crdt::WriteError> {
    let held = tree(before, WORKSPACE_TREE_KEY);
    let live = |node: NodeId| held.as_ref().is_some_and(|held| held.is_live(node));
    survivors.iter().filter(|&&(under, node)| under == path && live(node)).try_for_each(
        |&(_, node)| delete_node(before, WORKSPACE_TREE_KEY, node).map(|()| commit(before)),
    )
}

#[cfg(test)]
mod tests;
