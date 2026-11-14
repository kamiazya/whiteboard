//! Reading what a node SHOWS, without reading how it is stored: the readers of
//! `node-content.ts`, `node-resource.ts` and `asset-ref.ts` the layout and the
//! proposal layer's conflict check ask. A node's kind follows from its resource (ADR-0038 decision 3): inline
//! content is text, a location is a link when its media type is a URI list and
//! a file otherwise, and no resource at all is a frame.

use crate::spatial::{BackgroundStyle, NodeResource, SpatialNode};

/// Whether a node is a frame: it shows nothing, so it has no resource.
#[must_use]
pub const fn is_frame(node: &SpatialNode) -> bool {
    node.resource.is_none()
}

/// What a node shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Text,
    File,
    Link,
    Frame,
}

const URI_LIST: &str = "text/uri-list";

/// `resourceKind`: none for a resource nothing claims (no content, no location).
fn resource_kind(resource: &NodeResource) -> Option<NodeKind> {
    match resource {
        NodeResource { content: Some(_), .. } => Some(NodeKind::Text),
        NodeResource { location: Some(_), mime_type, .. } if mime_type == URI_LIST => {
            Some(NodeKind::Link)
        }
        NodeResource { location: Some(_), .. } => Some(NodeKind::File),
        NodeResource { .. } => None,
    }
}

/// `nodeKind`: none for a resource nothing claims.
#[must_use]
pub fn node_kind(node: &SpatialNode) -> Option<NodeKind> {
    node.resource.as_ref().map_or(Some(NodeKind::Frame), resource_kind)
}

fn resource_of(node: &SpatialNode, kind: NodeKind) -> Option<&NodeResource> {
    node.resource.as_ref().filter(|resource| resource_kind(resource) == Some(kind))
}

/// The markdown a text node carries.
#[must_use]
pub fn node_text(node: &SpatialNode) -> Option<&str> {
    resource_of(node, NodeKind::Text)?.content.as_deref()
}

/// Where a file node points.
#[must_use]
pub fn node_file(node: &SpatialNode) -> Option<&str> {
    resource_of(node, NodeKind::File)?.location.as_deref()
}

/// Where a link node points.
#[must_use]
pub fn node_url(node: &SpatialNode) -> Option<&str> {
    resource_of(node, NodeKind::Link)?.location.as_deref()
}

/// The fragment of a file node's location; a fragment means nothing without one.
#[must_use]
pub fn node_subpath(node: &SpatialNode) -> Option<&str> {
    resource_of(node, NodeKind::File)?.subpath.as_deref()
}

/// A frame's caption; no other node has one.
#[must_use]
pub fn frame_label(node: &SpatialNode) -> Option<&str> {
    if is_frame(node) { node.label.as_deref() } else { None }
}

/// A frame's background image reference.
#[must_use]
pub fn frame_background(node: &SpatialNode) -> Option<&str> {
    if is_frame(node) { node.background.as_deref() } else { None }
}

/// How a frame's background fills it.
#[must_use]
pub fn frame_background_style(node: &SpatialNode) -> Option<BackgroundStyle> {
    if is_frame(node) { node.background_style } else { None }
}

/// The one convention that tells a file node pointing at a stored image from one
/// pointing at a document: the `asset:` prefix, whose colon no path or id holds.
#[must_use]
pub fn is_image_ref(file: &str) -> bool {
    file.starts_with("asset:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn shows(mime_type: &str, content: Option<&str>, location: Option<&str>) -> SpatialNode {
        SpatialNode {
            resource: Some(NodeResource {
                mime_type: mime_type.to_owned(),
                content: content.map(str::to_owned),
                location: location.map(str::to_owned),
                subpath: Some("#s".to_owned()),
            }),
            label: Some("caption".to_owned()),
            background: Some("asset:b".to_owned()),
            background_style: Some(BackgroundStyle::Ratio),
            ..SpatialNode::default()
        }
    }

    #[test]
    fn a_node_reads_as_the_kind_its_resource_claims() {
        let text = shows(URI_LIST, Some("t"), None);
        let link = shows(URI_LIST, None, Some("https://x"));
        let file = shows("image/png", None, Some("asset:a"));
        let unclaimed = shows("image/png", None, None);
        let frame = SpatialNode { resource: None, ..text.clone() };
        assert_eq!(node_kind(&text), Some(NodeKind::Text));
        assert_eq!(node_kind(&link), Some(NodeKind::Link));
        assert_eq!(node_kind(&file), Some(NodeKind::File));
        assert_eq!(node_kind(&unclaimed), None);
        assert_eq!(node_kind(&frame), Some(NodeKind::Frame));
        assert_eq!([node_text(&text), node_url(&text), node_file(&text)], [Some("t"), None, None]);
        assert_eq!([node_url(&link), node_file(&link)], [Some("https://x"), None]);
        assert_eq!([node_file(&file), node_url(&file)], [Some("asset:a"), None]);
        assert_eq!([node_subpath(&file), node_subpath(&link)], [Some("#s"), None]);
        for node in [&text, &link, &file, &unclaimed] {
            assert_eq!(frame_label(node), None);
            assert_eq!(frame_background(node), None);
            assert_eq!(frame_background_style(node), None);
        }
        assert_eq!(frame_label(&frame), Some("caption"));
        assert_eq!(frame_background(&frame), Some("asset:b"));
        assert_eq!(frame_background_style(&frame), Some(BackgroundStyle::Ratio));
        assert!(is_image_ref("asset:x") && !is_image_ref("assets:x") && !is_image_ref("a"));
    }

    #[test]
    fn only_a_node_that_shows_nothing_is_a_frame() {
        assert!(is_frame(&SpatialNode::default()));
        let shown =
            SpatialNode { resource: Some(NodeResource::default()), ..SpatialNode::default() };
        assert!(!is_frame(&shown));
    }
}
