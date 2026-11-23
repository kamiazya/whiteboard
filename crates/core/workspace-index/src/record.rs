//! A workspace record, opened from the bytes a keeper stores, and what the
//! document index reads from it.

use crate::entry::Found;
use crate::index_rules::Node;
use crate::node_meta::{DocumentMeta, NodeRead, WORKSPACE_TREE_KEY};
use crate::trash::{TrashRow, read_trash_rows};
use crate::walk::{Walked, walk, walk_in};
use std::collections::BTreeSet;
use whiteboard_crdt::{
    CONTENT_KEYS, ContainerKind, Entry, ImportError, LoroDoc, Tree, content_digest_of,
    import_bytes, peek, set_peer_id, tree,
};
use whiteboard_model::Value;

pub(crate) const WORKSPACE_META_KEY: &str = "workspaceMeta";
pub(crate) const PINNED_KEY: &str = "pinned";

/// A document as the record stores it, placed by its ancestry.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedDocument {
    pub meta: DocumentMeta,
    pub path: String,
    pub content_digest: String,
}

/// A workspace record held for reading and for writing.
pub struct WorkspaceRecord {
    doc: LoroDoc,
}

impl WorkspaceRecord {
    /// The record the bytes of a snapshot hold.
    pub fn open(bytes: &[u8]) -> Result<Self, ImportError> {
        Ok(Self { doc: import_bytes(bytes)? })
    }

    /// The record the bytes of a snapshot hold, written as `peer` from here on.
    pub fn open_as(bytes: &[u8], peer: u64) -> Result<Self, ImportError> {
        let doc = import_bytes(bytes)?;
        set_peer_id(&doc, peer).map_err(|refused| ImportError(refused.0))?;
        Ok(Self { doc })
    }

    /// The loro document the record is, for a keeper to export and store.
    #[must_use]
    pub fn doc(&self) -> &LoroDoc {
        &self.doc
    }

    /// Every node, folders included, in tree order with its derived path.
    #[must_use]
    pub fn nodes(&self) -> Vec<Walked> {
        walk(&self.doc).0
    }

    /// The nodes as the index's rules read them, in tree order.
    #[must_use]
    pub fn index_nodes(&self) -> Vec<Node> {
        self.nodes().iter().map(Walked::as_node).collect()
    }

    /// The first node in tree order at `path`, a folder or a document.
    #[must_use]
    pub fn node_at(&self, path: &str) -> Option<Walked> {
        self.nodes().into_iter().find(|walked| walked.path == path)
    }

    /// The first document node in tree order that carries `document_id`.
    #[must_use]
    pub fn document_node(&self, document_id: &str) -> Option<Walked> {
        self.nodes().into_iter().find(|walked| {
            matches!(&walked.read, NodeRead::Document(meta) if meta.document_id == document_id)
        })
    }

    /// The content a document node holds, keyed by container, for its digest.
    fn content_of(tree: &Tree, walked: &Walked) -> Vec<(String, Value)> {
        CONTENT_KEYS
            .iter()
            .filter_map(|key| match tree.entry(walked.id, key)? {
                Entry::Value(value) | Entry::Container { value, .. } => {
                    Some(((*key).to_owned(), value))
                }
            })
            .collect()
    }

    fn found_of(tree: &Tree, walked: &Walked, meta: &DocumentMeta, shadowed: bool) -> Found {
        Found {
            document_id: meta.document_id.clone(),
            path: walked.path.clone(),
            kind: Some(meta.kind.clone()),
            name: meta.name.clone(),
            shadowed: shadowed.then_some(true),
            created_at: meta.created_at,
            updated_at: meta.updated_at,
            content_digest: content_digest_of(&Self::content_of(tree, walked)),
        }
    }

    /// Every document in tree order. One that follows an earlier document at
    /// its path is marked shadowed: shown rather than hidden, since the data
    /// converged and a listing that dropped half of it would look like loss.
    #[must_use]
    pub fn documents(&self) -> Vec<Found> {
        let Some(held) = tree(&self.doc, WORKSPACE_TREE_KEY) else { return Vec::new() };
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut out = Vec::new();
        for walked in walk_in(&held).0 {
            let NodeRead::Document(meta) = &walked.read else { continue };
            let shadowed = !seen.insert(walked.path.clone());
            out.push(Self::found_of(&held, &walked, meta, shadowed));
        }
        out
    }

    /// The first document in tree order that carries `document_id`.
    #[must_use]
    pub fn document_by_id(&self, document_id: &str) -> Option<Found> {
        let held = tree(&self.doc, WORKSPACE_TREE_KEY)?;
        walk_in(&held).0.into_iter().find_map(|walked| match &walked.read {
            NodeRead::Document(meta) if meta.document_id == document_id => {
                Some(Self::found_of(&held, &walked, meta, false))
            }
            _ => None,
        })
    }

    /// The first document in tree order that carries `document_id`, as it
    /// stands: every stored field, its path and the digest of its content.
    #[must_use]
    pub fn placed_document(&self, document_id: &str) -> Option<PlacedDocument> {
        let held = tree(&self.doc, WORKSPACE_TREE_KEY)?;
        let walked = walk_in(&held).0.into_iter().find(|walked| {
            matches!(&walked.read, NodeRead::Document(meta) if meta.document_id == document_id)
        })?;
        let NodeRead::Document(meta) = &walked.read else { return None };
        Some(PlacedDocument {
            meta: meta.clone(),
            path: walked.path.clone(),
            content_digest: content_digest_of(&Self::content_of(&held, &walked)),
        })
    }

    /// Every named folder path once, with the first name in tree order: either
    /// of two folder nodes at one path may be the one somebody named.
    #[must_use]
    pub fn folder_names(&self) -> Vec<(String, String)> {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut out = Vec::new();
        for walked in self.nodes() {
            let NodeRead::Folder { name: Some(name), .. } = &walked.read else { continue };
            if seen.insert(walked.path.clone()) {
                out.push((walked.path.clone(), name.clone()));
            }
        }
        out
    }

    /// The pinned documents' ids in pin order. Absent unless the record holds
    /// the list as a movable list; a read never opens one.
    #[must_use]
    pub fn pinned(&self) -> Vec<String> {
        match peek(&self.doc, &format!("{WORKSPACE_META_KEY}/{PINNED_KEY}")) {
            Some(Entry::Container { kind: ContainerKind::MovableList, value: Value::Seq(ids) }) => {
                ids.into_iter()
                    .filter_map(|id| match id {
                        Value::String(id) => Some(id),
                        _ => None,
                    })
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    /// What this workspace could still bring back, newest first.
    #[must_use]
    pub fn trash(&self) -> Vec<TrashRow> {
        read_trash_rows(&self.doc)
    }
}

#[cfg(test)]
mod tests;
