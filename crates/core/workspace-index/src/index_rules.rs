//! The index's rules over what a workspace record holds, separate from where
//! it holds it: when a name or a path is taken, and which trash row names bytes.

use crate::display_name::{
    Named, NamedKind, display_name_key, first_distinct_unnamed_path, moved_display_name_taken,
    sibling_display_name_taken,
};
use crate::document_path::is_self_or_descendant;

/// The two kinds of node a workspace record holds.
pub type NodeKind = NamedKind;

/// A node as these rules read it. A document's `name` and `document_id` are
/// its meta's; a folder's `name` is its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub kind: NodeKind,
    pub path: String,
    pub name: Option<String>,
    pub document_id: Option<String>,
}

impl Node {
    fn named(&self) -> Named<'_> {
        Named { path: &self.path, name: self.name.as_deref() }
    }
}

/// A refused duplicate: the kind and path the name was for, and the name the
/// existing sibling shows, which is what a refusal quotes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayNameTaken {
    pub kind: NodeKind,
    pub path: String,
    pub display_name: String,
}

/// A blob's address: its algorithm and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    pub algorithm: String,
    pub digest_hex: String,
}

/// A trash row, as far as the byte-sharing rule reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashEntry {
    pub document_id: String,
    pub blob: BlobRef,
}

/// Whether a write keeps the name its target already shows. Such a write is
/// never refused as a duplicate: a sibling that merged in under the same name
/// is one this keeper could not have refused.
#[must_use]
pub fn same_display_name(current: Option<&str>, next: &str) -> bool {
    current.is_some_and(|current| display_name_key(current) == display_name_key(next))
}

/// Refuses `name` for the document at `path` when another document directly
/// under the same parent already shows it; `document_id` leaves the document
/// itself out.
pub fn refuse_sibling_document_name(
    nodes: &[Node],
    path: &str,
    name: &str,
    document_id: Option<&str>,
) -> Result<(), DisplayNameTaken> {
    let others: Vec<Named<'_>> = nodes
        .iter()
        .filter(|node| {
            node.kind == NodeKind::Document && node.document_id.as_deref() != document_id
        })
        .map(Node::named)
        .collect();
    match sibling_display_name_taken(NodeKind::Document, &others, path, name) {
        Some(display_name) => {
            Err(DisplayNameTaken { kind: NodeKind::Document, path: path.to_owned(), display_name })
        }
        None => Ok(()),
    }
}

/// Refuses a move that would leave the node at `from` showing, under its new
/// parent, a name a sibling of the same kind already shows. Only the root of
/// the moving subtree changes parent.
pub fn refuse_moved_name(
    nodes: &[Node],
    moving: &[Node],
    from: &str,
    to: &str,
) -> Result<(), DisplayNameTaken> {
    for root in moving.iter().filter(|node| node.path == from) {
        let staying: Vec<Named<'_>> = nodes
            .iter()
            .filter(|node| {
                node.kind == root.kind
                    && !is_self_or_descendant(&node.path, from)
                    && !emptied_by(nodes, node, from)
            })
            .map(Node::named)
            .collect();
        let shown = moved_display_name_taken(root.kind, &staying, from, to, root.name.as_deref());
        if let Some(display_name) = shown {
            return Err(DisplayNameTaken { kind: root.kind, path: to.to_owned(), display_name });
        }
    }
    Ok(())
}

/// Whether moving `from` away leaves `node` — one of its ancestors — with no
/// document under it, so the move prunes it with it.
fn emptied_by(nodes: &[Node], node: &Node, from: &str) -> bool {
    if node.kind != NodeKind::Folder || !is_self_or_descendant(from, &node.path) {
        return false;
    }
    !nodes.iter().any(|other| {
        other.kind == NodeKind::Document
            && is_self_or_descendant(&other.path, &node.path)
            && !is_self_or_descendant(&other.path, from)
    })
}

/// The address an unnamed document takes so it does not read like a named
/// sibling. The requested address stands when no suffix in range is free.
#[must_use]
pub fn distinct_unnamed_path(nodes: &[Node], path: &str) -> String {
    let documents: Vec<Named<'_>> =
        nodes.iter().filter(|node| node.kind == NodeKind::Document).map(Node::named).collect();
    first_distinct_unnamed_path(path, &documents, |each| nodes.iter().any(|node| node.path == each))
        .unwrap_or_else(|| path.to_owned())
}

/// Whether a purge or restore of `entry` must leave its bytes for another trash row.
#[must_use]
pub fn is_named_by_another_row(rows: &[TrashEntry], entry: &TrashEntry) -> bool {
    rows.iter().any(|row| row.document_id != entry.document_id && row.blob == entry.blob)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn keeping_a_name_is_the_same_name_unless_there_is_none() {
        assert!(same_display_name(Some(" Plan"), "plan"));
        assert!(!same_display_name(None, "plan"));
    }

    fn named_folder(path: &str, name: &str) -> Node {
        Node {
            kind: NodeKind::Folder,
            path: path.to_owned(),
            name: Some(name.to_owned()),
            document_id: None,
        }
    }

    #[test]
    fn an_empty_folder_the_move_does_not_leave_still_shows_its_name() {
        let document = Node {
            kind: NodeKind::Document,
            path: "x/b/d".to_owned(),
            name: None,
            document_id: Some("d".to_owned()),
        };
        let nodes = [
            named_folder("a", "Notes"),
            named_folder("x", "X"),
            named_folder("x/b", "Notes"),
            document.clone(),
        ];
        let moving = [named_folder("x/b", "Notes"), document];
        let refused = refuse_moved_name(&nodes, &moving, "x/b", "c");
        assert_eq!(refused.map_err(|taken| taken.path), Err("c".to_owned()));
    }

    #[test]
    fn a_blob_is_named_by_another_row_only_across_documents() {
        let blob = BlobRef { algorithm: "sha-256".to_owned(), digest_hex: "00".to_owned() };
        let row = |id: &str| TrashEntry { document_id: id.to_owned(), blob: blob.clone() };
        assert!(!is_named_by_another_row(&[row("a")], &row("a")));
        assert!(is_named_by_another_row(&[row("b")], &row("a")));
    }

    #[test]
    fn an_unnamed_path_with_no_free_suffix_keeps_the_address_asked_for() {
        let long = "a".repeat(1024);
        let held = Node {
            kind: NodeKind::Document,
            path: long.clone(),
            name: None,
            document_id: Some("01ARZ3NDEKTSV4RRFFQ69G5FAA".to_owned()),
        };
        assert_eq!(distinct_unnamed_path(&[held], &long), long);
    }
}
