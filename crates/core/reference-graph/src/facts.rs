//! The facts one document's content contributes: its references, the prose
//! that mention detection joins against other documents' names, and what in it
//! carries tags.

use crate::DocumentContent;
use crate::references::{NodeVia, RawReference, text_references};
use whiteboard_model::node_content::{frame_label, node_file, node_text};
use whiteboard_model::spatial::{CanvasEdge, SpatialCanvas, SpatialNode};
use whiteboard_search::{SearchableContent, searchable_texts};

/// A document's content with its OKF core tags, as a keeper loaded it.
#[derive(Debug, Clone, Copy)]
pub struct LoadedContent<'a> {
    pub content: DocumentContent<'a>,
    pub tags: Option<&'a [String]>,
}

/// What can carry tags (ADR-0040 decision 2): the markdown document itself, a
/// board, a node or an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BearerKind {
    Document,
    Board,
    Node,
    Edge,
}

impl BearerKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Board => "board",
            Self::Node => "node",
            Self::Edge => "edge",
        }
    }
}

/// One thing in a document that carries tags. A filter matches when ONE
/// bearer carries every listed tag, and `text` is what an answer names as the
/// excerpt: a node's text, an edge's label or its two ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagBearer {
    pub what: BearerKind,
    /// The node's or edge's id; absent on the document and the board.
    pub id: Option<String>,
    pub text: String,
    pub tags: Vec<String>,
}

/// The content half alone, which a stamp-validated cache may keep: index
/// authority (path, name, kind) stays out, so a rename is correct with no
/// invalidation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentFacts {
    pub refs: Vec<RawReference>,
    pub texts: Vec<String>,
    pub bearers: Vec<TagBearer>,
}

fn spatial_references(canvas: &SpatialCanvas) -> Vec<RawReference> {
    let mut refs = Vec::new();
    for node in &canvas.nodes {
        if let Some(embed) = &node.embed {
            refs.push(RawReference::Node {
                target: embed.document_id.clone(),
                via: NodeVia::Embed,
                context: "embedded on this canvas".to_owned(),
            });
        } else if let Some(file) = node_file(node) {
            refs.push(RawReference::Node {
                target: file.to_owned(),
                via: NodeVia::File,
                context: "referenced by a file node".to_owned(),
            });
        } else if let Some(text) = node_text(node) {
            refs.extend(text_references(text));
        }
    }
    refs
}

/// The name a reader knows a node by: its text, a frame's label, or its id.
fn node_name(node: &SpatialNode) -> &str {
    match node_text(node).or_else(|| frame_label(node)) {
        Some(own) if !own.is_empty() => own,
        _ => &node.id,
    }
}

fn edge_name(edge: &CanvasEdge, canvas: &SpatialCanvas) -> String {
    if let Some(label) = edge.label.as_deref().filter(|label| !label.is_empty()) {
        return label.to_owned();
    }
    let name =
        |id: &str| canvas.nodes.iter().find(|node| node.id == id).map_or(id, node_name).to_owned();
    format!("{} → {}", name(&edge.from.node), name(&edge.to.node))
}

fn tagged(tags: Option<&[String]>) -> Option<&[String]> {
    tags.filter(|tags| !tags.is_empty())
}

fn spatial_bearers(canvas: &SpatialCanvas) -> Vec<TagBearer> {
    let mut bearers = Vec::new();
    if let Some(tags) = tagged(canvas.tags.as_deref()) {
        bearers.push(TagBearer {
            what: BearerKind::Board,
            id: None,
            text: String::new(),
            tags: tags.to_vec(),
        });
    }
    for node in &canvas.nodes {
        if let Some(tags) = tagged(node.tags.as_deref()) {
            bearers.push(TagBearer {
                what: BearerKind::Node,
                id: Some(node.id.clone()),
                text: node_name(node).to_owned(),
                tags: tags.to_vec(),
            });
        }
    }
    for edge in &canvas.edges {
        if let Some(tags) = tagged(edge.tags.as_deref()) {
            bearers.push(TagBearer {
                what: BearerKind::Edge,
                id: Some(edge.id.clone()),
                text: edge_name(edge, canvas),
                tags: tags.to_vec(),
            });
        }
    }
    bearers
}

/// Everything a document contains that carries tags, from content already
/// read: the one definition of "what bears a tag", so two keepers cannot
/// count different things.
#[must_use]
pub fn tag_bearers_of(loaded: &LoadedContent<'_>) -> Vec<TagBearer> {
    match loaded.content {
        DocumentContent::Spatial(canvas) => spatial_bearers(canvas),
        DocumentContent::Markdown { .. } => tagged(loaded.tags)
            .map(|tags| {
                vec![TagBearer {
                    what: BearerKind::Document,
                    id: None,
                    text: String::new(),
                    tags: tags.to_vec(),
                }]
            })
            .unwrap_or_default(),
    }
}

/// What `loaded` contributes. The prose is what search ranks, by construction.
#[must_use]
pub fn extract_content_facts(loaded: &LoadedContent<'_>) -> ContentFacts {
    let (refs, texts) = match loaded.content {
        DocumentContent::Markdown { body } => (
            text_references(body),
            searchable_texts(SearchableContent::Markdown { body, description: None }),
        ),
        DocumentContent::Spatial(canvas) => {
            (spatial_references(canvas), searchable_texts(SearchableContent::Spatial(canvas)))
        }
    };
    ContentFacts { refs, texts, bearers: tag_bearers_of(loaded) }
}

/// A document's OWN tags and the ones its contents carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitTags {
    pub own: Vec<String>,
    pub carried: Vec<String>,
}

/// Own is the document's frontmatter or its board's envelope: one bearer,
/// because a document has one of those. Carried is the union over its nodes
/// and edges, deduplicated, because a tag on three boxes is one tag the
/// document contains. Any other bearer kind belongs to neither.
pub fn split_bearer_tags<'a>(
    bearers: impl IntoIterator<Item = (&'a str, &'a [String])> + Clone,
) -> SplitTags {
    let own = bearers
        .clone()
        .into_iter()
        .find(|(what, _)| matches!(*what, "document" | "board"))
        .map(|(_, tags)| tags.to_vec())
        .unwrap_or_default();
    let mut carried: Vec<String> = Vec::new();
    for (what, tags) in bearers {
        if !matches!(what, "node" | "edge") {
            continue;
        }
        for tag in tags {
            if !carried.contains(tag) {
                carried.push(tag.clone());
            }
        }
    }
    SplitTags { own, carried }
}

#[cfg(test)]
mod tests {
    use super::{BearerKind, split_bearer_tags};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_bearer_kind_is_named_as_it_is_stored() {
        let names = [BearerKind::Document, BearerKind::Board, BearerKind::Node, BearerKind::Edge]
            .map(BearerKind::as_str);
        assert_eq!(names, ["document", "board", "node", "edge"]);
    }

    #[test]
    fn carried_tags_are_deduplicated_in_first_seen_order() {
        let x = vec!["x".to_owned(), "y".to_owned()];
        let y = vec!["y".to_owned(), "z".to_owned()];
        let split = split_bearer_tags([("node", x.as_slice()), ("edge", y.as_slice())]);
        assert_eq!(split.carried, ["x", "y", "z"]);
        assert!(split.own.is_empty());
    }
}
