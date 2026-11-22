//! What a tree node records about itself, read without its content.

use whiteboard_crdt::{Entry, NodeId, Tree};
use whiteboard_model::Value;
use whiteboard_model::checks::canonical_ulid;

/// The one root container a workspace record's tree lives in.
pub const WORKSPACE_TREE_KEY: &str = "tree";

/// The keys a node keeps for itself; every other key is content.
pub(crate) const META_KEYS: [&str; 7] =
    ["documentId", "segment", "kind", "name", "nameChosen", "createdAt", "updatedAt"];

/// What a document node records about the document it is.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentMeta {
    pub document_id: String,
    pub segment: String,
    pub kind: String,
    pub name: Option<String>,
    /// Set beside a name somebody chose, and cleared with it.
    pub name_chosen: bool,
    pub created_at: Option<f64>,
    pub updated_at: Option<f64>,
}

/// A node as a walk reads it: a document, or a folder standing in for a path part.
#[derive(Debug, Clone, PartialEq)]
pub enum NodeRead {
    Document(DocumentMeta),
    Folder { segment: String, name: Option<String> },
}

impl NodeRead {
    /// The node's own path component.
    #[must_use]
    pub fn segment(&self) -> &str {
        match self {
            Self::Document(meta) => &meta.segment,
            Self::Folder { segment, .. } => segment,
        }
    }
}

/// Every key the node holds; a meta key's value is read and any other is
/// present as nothing, because neither shape reads one. `None` when a meta key
/// holds a container, which leaves the node unreadable.
fn raw_meta(tree: &Tree, node: NodeId) -> Option<Vec<(String, Value)>> {
    let mut raw = Vec::new();
    for key in tree.keys(node) {
        if !META_KEYS.contains(&key.as_str()) {
            raw.push((key, Value::Null));
            continue;
        }
        match tree.entry(node, &key) {
            Some(Entry::Container { .. }) => return None,
            Some(Entry::Value(value)) => raw.push((key, value)),
            None => {}
        }
    }
    Some(raw)
}

fn field<'a>(raw: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    raw.iter().find(|(held, _)| held == key).map(|(_, value)| value)
}

/// A string that is present, or `Ok(None)` when absent; `Err` when it is
/// present as anything else or empty (`z.string().min(1).optional()`).
fn optional_text(raw: &[(String, Value)], key: &str) -> Result<Option<String>, ()> {
    match field(raw, key) {
        None => Ok(None),
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

/// `z.number().int().optional()`: a safe integer, or absent.
fn optional_integer(raw: &[(String, Value)], key: &str) -> Result<Option<f64>, ()> {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    match field(raw, key) {
        None => Ok(None),
        Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE => {
            Ok(Some(*n))
        }
        Some(_) => Err(()),
    }
}

fn as_document(raw: &[(String, Value)]) -> Option<DocumentMeta> {
    let Some(Value::String(document_id)) = field(raw, "documentId") else { return None };
    let Some(Value::String(kind)) = field(raw, "kind") else { return None };
    if !canonical_ulid(document_id) || !matches!(kind.as_str(), "spatial" | "markdown") {
        return None;
    }
    if !matches!(field(raw, "nameChosen"), None | Some(Value::Bool(true))) {
        return None;
    }
    Some(DocumentMeta {
        document_id: document_id.clone(),
        segment: optional_text(raw, "segment").ok().flatten()?,
        kind: kind.clone(),
        name: optional_text(raw, "name").ok()?,
        name_chosen: field(raw, "nameChosen").is_some(),
        created_at: optional_integer(raw, "createdAt").ok()?,
        updated_at: optional_integer(raw, "updatedAt").ok()?,
    })
}

/// A folder's meta is strict: its segment and its name, and nothing else.
fn as_folder(raw: &[(String, Value)]) -> Option<NodeRead> {
    if raw.iter().any(|(key, _)| key != "segment" && key != "name") {
        return None;
    }
    Some(NodeRead::Folder {
        segment: optional_text(raw, "segment").ok().flatten()?,
        name: optional_text(raw, "name").ok()?,
    })
}

/// What `node` records about itself, or `None` for a node this build cannot read.
#[must_use]
pub fn read_node(tree: &Tree, node: NodeId) -> Option<NodeRead> {
    let raw = raw_meta(tree, node)?;
    as_document(&raw).map(NodeRead::Document).or_else(|| as_folder(&raw))
}

#[cfg(test)]
mod tests;
