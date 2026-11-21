//! The same node showing different text, or pointing at a different file.

use whiteboard_model::node_content::{node_file, node_text};
use whiteboard_model::spatial::SpatialNode;

const MARKDOWN_MIME_TYPE: &str = "text/markdown";

/// The node showing `text`; one that shows no text is answered unchanged.
#[must_use]
pub fn with_node_text(node: &SpatialNode, text: &str) -> SpatialNode {
    if node_text(node).is_none() {
        return node.clone();
    }
    let mut next = node.clone();
    if let Some(resource) = next.resource.as_mut() {
        MARKDOWN_MIME_TYPE.clone_into(&mut resource.mime_type);
        resource.content = Some(text.to_owned());
    }
    next
}

/// The node pointing at `file`, dropping the subpath of the old reference,
/// which names a place inside a document this no longer points at.
#[must_use]
pub fn with_node_file(node: &SpatialNode, file: &str) -> SpatialNode {
    if node_file(node).is_none() {
        return node.clone();
    }
    let mut next = node.clone();
    if let Some(resource) = next.resource.as_mut() {
        resource.subpath = None;
        resource.location = Some(file.to_owned());
    }
    next
}

#[cfg(test)]
mod tests {
    use super::{with_node_file, with_node_text};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::spatial::{NodeResource, SpatialNode};

    fn resource(content: Option<&str>, location: Option<&str>) -> SpatialNode {
        SpatialNode {
            resource: Some(NodeResource {
                mime_type: "x/y".to_owned(),
                content: content.map(str::to_owned),
                location: location.map(str::to_owned),
                subpath: Some("#s".to_owned()),
            }),
            ..SpatialNode::default()
        }
    }

    #[test]
    fn text_is_replaced_on_a_text_node_and_a_frame_is_left_alone() {
        let text = with_node_text(&resource(Some("a"), None), "b");
        let held = text.resource.expect("a resource");
        assert_eq!(
            (held.mime_type.as_str(), held.content.as_deref()),
            ("text/markdown", Some("b"))
        );
        let frame = SpatialNode::default();
        assert_eq!(with_node_text(&frame, "b"), frame);
    }

    #[test]
    fn a_file_is_repointed_without_its_subpath_and_a_text_node_is_left_alone() {
        let file = with_node_file(&resource(None, Some("a")), "b").resource.expect("a resource");
        assert_eq!((file.location.as_deref(), file.subpath), (Some("b"), None));
        let text = resource(Some("a"), None);
        assert_eq!(with_node_file(&text, "b"), text);
    }
}
