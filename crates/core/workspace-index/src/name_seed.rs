//! A document named after the title its body announces (`nameToSeed` and
//! `seedNode` in the TypeScript's `name-from-title.ts`): while nobody chose a
//! name and the document still sits at a generated path, its name follows the
//! body's level-1 heading, keeping up with one still being typed, and a title
//! another document beside it already shows is not written.

use crate::display_name::{Named, NamedKind, display_name_key, shown_name};
use crate::document_path::is_generated_document_path;
use crate::node_meta::{NodeRead, WORKSPACE_TREE_KEY, read_document_unnamed, read_node};
use crate::title_from_body::title_from_markdown_body;
use std::collections::VecDeque;
use whiteboard_crdt::{
    ContainerKind, Entry, LoroDoc, NodeId, Tree, WriteError, delete_meta, set_meta,
};
use whiteboard_model::Value;

/// What a seed does to a node's name.
#[derive(Debug, PartialEq, Eq)]
enum Seed {
    /// Leave it as it is.
    Keep,
    /// Take back a name this seeded.
    Clear,
    /// Name it.
    Name(String),
}

/// Whether `title` is what another DOCUMENT beside `node` shows, compared as
/// the sibling rule compares; a folder of the same name is no collision. A
/// sibling's name is read loosely: one that is not text shows its segment.
fn sibling_document_shows(tree: &Tree, node: NodeId, title: &str) -> bool {
    let key = display_name_key(title);
    let siblings = tree.parent(node).map_or_else(|| tree.roots(), |parent| tree.children(parent));
    siblings.into_iter().filter(|&sibling| sibling != node).any(|sibling| {
        let Some(meta) = read_document_unnamed(tree, sibling) else { return false };
        let name = match tree.entry(sibling, "name") {
            Some(Entry::Value(Value::String(name))) => Some(name),
            _ => None,
        };
        let named = Named { path: &meta.segment, name: name.as_deref() };
        display_name_key(&shown_name(NamedKind::Document, named)) == key
    })
}

/// The body a node holds as text, read where it is and never opened.
fn body_of(tree: &Tree, node: NodeId) -> Option<String> {
    match tree.entry(node, "body")? {
        Entry::Container { kind: ContainerKind::Text, value: Value::String(body) } => Some(body),
        _ => None,
    }
}

/// What the node's name should become: a name somebody chose, or one at an
/// address a person picked, is kept; past that the heading names it, and a
/// name the seed gave from a heading still being typed may be replaced.
fn name_to_seed(tree: &Tree, node: NodeId) -> Seed {
    let Some(NodeRead::Document(meta)) = read_node(tree, node) else { return Seed::Keep };
    if meta.name_chosen || !is_generated_document_path(&meta.segment) {
        return Seed::Keep;
    }
    let Some(title) = body_of(tree, node).as_deref().and_then(title_from_markdown_body) else {
        return Seed::Keep;
    };
    let name = meta.name.as_deref();
    if name == Some(title.as_str()) || !name.is_none_or(|name| title.starts_with(name)) {
        return Seed::Keep;
    }
    if sibling_document_shows(tree, node, &title) {
        return if name.is_none() { Seed::Keep } else { Seed::Clear };
    }
    Seed::Name(title)
}

/// Seeds `node`'s name, uncommitted.
pub(crate) fn seed_node(doc: &LoroDoc, tree: &Tree, node: NodeId) -> Result<(), WriteError> {
    match name_to_seed(tree, node) {
        Seed::Keep => Ok(()),
        Seed::Clear => delete_meta(doc, WORKSPACE_TREE_KEY, node, "name"),
        Seed::Name(name) => set_meta(doc, WORKSPACE_TREE_KEY, node, "name", &Value::String(name)),
    }
}

/// The first node, breadth first from the roots as npm loro-crdt's
/// `getNodes` lists them, whose `documentId` is `document_id`, whatever else
/// it holds.
pub(crate) fn first_node_naming(tree: &Tree, document_id: &str) -> Option<NodeId> {
    let mut queue: VecDeque<NodeId> = tree.roots().into();
    while let Some(node) = queue.pop_front() {
        if matches!(tree.entry(node, "documentId"), Some(Entry::Value(Value::String(id))) if id == document_id)
        {
            return Some(node);
        }
        queue.extend(tree.children(node));
    }
    None
}
