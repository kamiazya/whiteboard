//! What text a document contributes to search, as one definition, and the
//! folder names that find a document beyond its own text.

use std::collections::BTreeMap;
use whiteboard_model::node_content::{NodeKind, frame_label, node_kind, node_text, node_url};
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

/// A document's content, as much of it as search needs to see.
#[derive(Debug, Clone, Copy)]
pub enum SearchableContent<'a> {
    Markdown { body: &'a str, description: Option<&'a str> },
    Spatial(&'a SpatialCanvas),
}

/// What each kind of node contributes: a text node its markdown, a link its
/// url (the label a canvas draws for it), a frame its caption. A file node
/// contributes NOTHING, deliberately: its readable label is the resolved
/// reference's, which needs a lookup this crate does not take, and the raw
/// reference is an opaque id.
fn node_contribution(kind: NodeKind, node: &SpatialNode) -> Option<&str> {
    match kind {
        NodeKind::Text => node_text(node),
        NodeKind::Link => node_url(node),
        NodeKind::Frame => frame_label(node),
        NodeKind::File => None,
    }
}

/// What text a document contributes to search. Each string stays separate so a
/// snippet can say WHICH source matched. What it returns is also the embedding
/// input on the semantic path, so its ORDER decides which part of a long
/// document a vector sees at all.
#[must_use]
pub fn searchable_texts(content: SearchableContent<'_>) -> Vec<String> {
    match content {
        SearchableContent::Markdown { body, description } => {
            // The description is the document's own summary and leads, so a long
            // body that overflows the embedder's window still leaves it inside.
            match description {
                Some(summary) if !summary.is_empty() => vec![summary.to_owned(), body.to_owned()],
                _ => vec![body.to_owned()],
            }
        }
        SearchableContent::Spatial(canvas) => {
            // A node showing a resource nothing in the registry claims
            // contributes nothing: it has no text a reader sees.
            let nodes = canvas.nodes.iter().filter_map(|node| {
                node_kind(node).and_then(|kind| node_contribution(kind, node)).map(str::to_owned)
            });
            let edges = canvas.edges.iter().filter_map(|edge| edge.label.clone());
            nodes.chain(edges).collect()
        }
    }
}

/// The display names of the named folders a document at `path` sits in, top
/// down. An unnamed folder adds nothing: its segment is in the path already.
#[must_use]
pub fn folder_names_of(path: &str, names: &BTreeMap<String, String>) -> Vec<String> {
    path.match_indices('/')
        .filter_map(|(cut, _)| path.get(..cut).and_then(|folder| names.get(folder)).cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_markdown_description_leads_unless_empty() {
        let texts =
            |description| searchable_texts(SearchableContent::Markdown { body: "b", description });
        assert_eq!(texts(Some("d")), ["d", "b"]);
        assert_eq!(texts(Some("")), ["b"]);
        assert_eq!(texts(None), ["b"]);
    }

    #[test]
    fn a_folder_is_named_by_each_prefix_that_has_a_name() {
        let names: BTreeMap<String, String> =
            [("a".to_owned(), "Alpha".to_owned()), ("a/b".to_owned(), "Beta".to_owned())].into();
        assert_eq!(folder_names_of("a/b/c/d", &names), ["Alpha", "Beta"]);
        assert!(folder_names_of("a", &names).is_empty());
        assert!(folder_names_of("x/y", &names).is_empty());
    }
}
