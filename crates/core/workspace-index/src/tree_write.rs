//! The writers over a workspace record's tree and the maps beside it, one loro
//! call for each the TypeScript's writers make, so a write appends the same
//! operations and the record's version vector moves the same way.

use crate::display_name::js_trim;
use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY};
use crate::record::{PINNED_KEY, WORKSPACE_META_KEY};
use crate::walk::{Walked, walk};
use std::collections::BTreeMap;
use whiteboard_crdt::{
    ContainerKind, LoroDoc, LoroValue, NodeId, WriteError, commit, create_node, delete_meta,
    delete_node, move_node, open_meta_container, open_root_list, set_meta,
};
use whiteboard_model::Value;

/// The content containers a document node holds from its creation, and what
/// each is, in the order they are attached.
const CONTENT_CONTAINERS: [(&str, ContainerKind); 13] = [
    ("nodes", ContainerKind::Map),
    ("edges", ContainerKind::Map),
    ("lines", ContainerKind::Map),
    ("canvas", ContainerKind::Map),
    ("threads", ContainerKind::Map),
    ("proposals", ContainerKind::Map),
    ("facets", ContainerKind::Map),
    ("nodeLocks", ContainerKind::Map),
    ("edgeLocks", ContainerKind::Map),
    ("core", ContainerKind::Map),
    ("trust", ContainerKind::Map),
    ("document", ContainerKind::Map),
    ("body", ContainerKind::Text),
];

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// Pins or unpins `document_id`. A pin keeps the position it already has, and
/// the list is opened even to unpin from a record that never held one.
pub fn set_pinned(doc: &LoroDoc, document_id: &str, pinned: bool) -> Result<(), WriteError> {
    let list = open_root_list(doc, WORKSPACE_META_KEY, PINNED_KEY)?;
    let at = list
        .to_vec()
        .iter()
        .position(|held| matches!(held, LoroValue::String(id) if id.as_str() == document_id));
    match (pinned, at) {
        (true, None) => list.push(document_id)?,
        (false, Some(index)) => list.delete(index, 1)?,
        _ => {}
    }
    commit(doc);
    Ok(())
}

/// Writes a name somebody chose with its mark, or clears both.
pub fn set_chosen_name(doc: &LoroDoc, node: NodeId, name: Option<&str>) -> Result<(), WriteError> {
    let tree = WORKSPACE_TREE_KEY;
    if let Some(name) = name {
        set_meta(doc, tree, node, "name", &text(name))?;
        set_meta(doc, tree, node, "nameChosen", &Value::Bool(true))
    } else {
        delete_meta(doc, tree, node, "name")?;
        delete_meta(doc, tree, node, "nameChosen")
    }
}

/// Names the document node, or clears its name for a blank or absent one.
pub fn set_document_name(
    doc: &LoroDoc,
    node: NodeId,
    name: Option<&str>,
) -> Result<(), WriteError> {
    set_chosen_name(doc, node, name.filter(|name| !js_trim(name).is_empty()))?;
    commit(doc);
    Ok(())
}

/// Names the folder at `path`, or with no name clears it from every folder node
/// there. A set writes the first folder node in tree order, trimmed; a clear
/// reaches them all, since a name left on a second node would show again the
/// moment the first stopped being first. `false` when no folder stands there.
pub fn set_folder_name(doc: &LoroDoc, path: &str, name: Option<&str>) -> Result<bool, WriteError> {
    let folders: Vec<Walked> = walk(doc)
        .0
        .into_iter()
        .filter(|walked| walked.path == path && matches!(walked.read, NodeRead::Folder { .. }))
        .collect();
    let Some(first) = folders.first() else { return Ok(false) };
    match name {
        None => {
            for walked in &folders {
                if matches!(walked.read, NodeRead::Folder { name: Some(_), .. }) {
                    delete_meta(doc, WORKSPACE_TREE_KEY, walked.id, "name")?;
                }
            }
        }
        Some(name) => {
            set_meta(doc, WORKSPACE_TREE_KEY, first.id, "name", &text(js_trim(name)))?;
        }
    }
    commit(doc);
    Ok(true)
}

/// Gives back the names a trash row kept to the folders standing again and
/// showing none. A name a folder has been given since wins, and one the model
/// refuses is skipped rather than failing the restore.
pub fn reapply_folder_names(doc: &LoroDoc, names: &[(String, String)]) -> Result<(), WriteError> {
    let showing: Vec<String> = walk(doc)
        .0
        .into_iter()
        .filter(|walked| matches!(walked.read, NodeRead::Folder { name: Some(_), .. }))
        .map(|walked| walked.path)
        .collect();
    for (path, name) in names {
        if showing.contains(path) || crate::write_input::folder_name_refused(name) {
            continue;
        }
        set_folder_name(doc, path, Some(name))?;
    }
    Ok(())
}

/// The first node in tree order at each path of `nodes`.
fn first_by_path(nodes: Vec<Walked>) -> BTreeMap<String, Walked> {
    let mut first = BTreeMap::new();
    for walked in nodes {
        first.entry(walked.path.clone()).or_insert(walked);
    }
    first
}

/// Makes every folder `segments` needs and answers the deepest one's id; `None`
/// is the workspace root. A node already at a path is reused whatever it is,
/// a document included, so `a/b` under a document `a` hangs off it.
pub fn ensure_folder_path(doc: &LoroDoc, segments: &[&str]) -> Result<Option<NodeId>, WriteError> {
    let along = first_by_path(walk(doc).0);
    let mut parent: Option<NodeId> = None;
    let mut prefix = String::new();
    for segment in segments {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(segment);
        if let Some(existing) = along.get(&prefix) {
            parent = Some(existing.id);
            continue;
        }
        let node = create_node(doc, WORKSPACE_TREE_KEY, parent)?;
        set_meta(doc, WORKSPACE_TREE_KEY, node, "segment", &text(segment))?;
        parent = Some(node);
    }
    commit(doc);
    Ok(parent)
}

/// Opens every content container a document node holds from its creation, so
/// a later read of one is a lookup and writes nothing.
pub fn attach_content_containers(doc: &LoroDoc, node: NodeId) -> Result<(), WriteError> {
    for (key, kind) in CONTENT_CONTAINERS {
        open_meta_container(doc, WORKSPACE_TREE_KEY, node, key, kind)?;
    }
    Ok(())
}

/// What a created document records about itself.
pub struct NewDocument<'a> {
    pub document_id: &'a str,
    pub kind: &'a str,
    pub name: Option<&'a str>,
    pub now_ms: f64,
}

/// Creates a document at `path`, making the folders above it. A folder already
/// standing there is promoted to the document; `false`, with nothing written,
/// when a document already owns the path.
pub fn create_document_at_path(
    doc: &LoroDoc,
    path: &str,
    document: &NewDocument<'_>,
) -> Result<bool, WriteError> {
    let segments: Vec<&str> = path.split('/').collect();
    let own = segments.last().copied().unwrap_or(path);
    let existing = walk(doc).0.into_iter().find(|walked| walked.path == path);
    if matches!(existing, Some(Walked { read: NodeRead::Document(_), .. })) {
        return Ok(false);
    }
    let named_folder =
        matches!(&existing, Some(Walked { read: NodeRead::Folder { name: Some(_), .. }, .. }));
    let node = if let Some(walked) = existing {
        walked.id
    } else {
        let above = segments.get(..segments.len().saturating_sub(1)).unwrap_or_default();
        create_node(doc, WORKSPACE_TREE_KEY, ensure_folder_path(doc, above)?)?
    };
    let tree = WORKSPACE_TREE_KEY;
    set_meta(doc, tree, node, "documentId", &text(document.document_id))?;
    set_meta(doc, tree, node, "segment", &text(own))?;
    set_meta(doc, tree, node, "kind", &text(document.kind))?;
    match document.name {
        Some(name) => set_chosen_name(doc, node, Some(name))?,
        // A promoted folder's name was the folder's, not one chosen for the document.
        None if named_folder => delete_meta(doc, tree, node, "name")?,
        None => {}
    }
    set_meta(doc, tree, node, "createdAt", &Value::Number(document.now_ms))?;
    set_meta(doc, tree, node, "updatedAt", &Value::Number(document.now_ms))?;
    attach_content_containers(doc, node)?;
    commit(doc);
    Ok(true)
}

/// Re-parents the node at `from` to sit at `to`, renaming its own segment; its
/// descendants come with it. `false` when nothing stands at `from`.
pub fn move_node_to_path(doc: &LoroDoc, from: &str, to: &str) -> Result<bool, WriteError> {
    let Some(source) = walk(doc).0.into_iter().find(|walked| walked.path == from) else {
        return Ok(false);
    };
    let segments: Vec<&str> = to.split('/').collect();
    let own = segments.last().copied().unwrap_or(to);
    let above = segments.get(..segments.len().saturating_sub(1)).unwrap_or_default();
    let parent = ensure_folder_path(doc, above)?;
    move_node(doc, WORKSPACE_TREE_KEY, source.id, parent)?;
    set_meta(doc, WORKSPACE_TREE_KEY, source.id, "segment", &text(own))?;
    commit(doc);
    Ok(true)
}

/// Removes the folders that hold nothing, from the deepest end of one walk, so
/// emptying a folder can empty its parent in the same pass.
pub fn prune_empty_folders(doc: &LoroDoc) -> Result<(), WriteError> {
    for walked in walk(doc).0.iter().rev() {
        if !matches!(walked.read, NodeRead::Folder { .. }) {
            continue;
        }
        if whiteboard_crdt::tree_children(doc, WORKSPACE_TREE_KEY, walked.id).is_empty() {
            delete_node(doc, WORKSPACE_TREE_KEY, walked.id)?;
        }
    }
    commit(doc);
    Ok(())
}

/// Removes the first node in tree order at `path`, whatever it is, with its
/// subtree. `false` when nothing stands there.
pub fn delete_node_at_path(doc: &LoroDoc, path: &str) -> Result<bool, WriteError> {
    let Some(found) = walk(doc).0.into_iter().find(|walked| walked.path == path) else {
        return Ok(false);
    };
    delete_node(doc, WORKSPACE_TREE_KEY, found.id)?;
    commit(doc);
    Ok(true)
}
