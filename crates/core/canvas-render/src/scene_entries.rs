//! The one producer of stable top-level scene-entry keys, shared by the keyed
//! SVG renderer and the scene-diff scoreboard.
//!
//! Identified entries (chrome shapes, edges) key by their id; the content
//! entries that follow a node's chrome inherit that owner id plus an ordinal,
//! matching the documented emission order. Entries before any identified one
//! fall under the `preamble` owner, so a hand-built scene with no ids still
//! keys by position.
//!
//! The same walk answers whether an entry belongs to the ANNOTATION LAYER, from
//! `comment_chrome` and never from the key's shape: a stored comment id may
//! contain a `/` exactly like a document node id can. Ownership carries it, so
//! the count on a pin and the body in a bubble, which have no id of their own,
//! are marked too.

use whiteboard_scene::{Scene, SceneNode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneEntry {
    pub key: String,
    /// Part of the annotation layer rather than of the drawn canvas.
    pub annotation: bool,
}

fn identity(node: &SceneNode) -> Option<(&str, bool)> {
    match node {
        SceneNode::Shape(shape) => shape.id.as_deref().map(|id| (id, shape.comment_chrome)),
        SceneNode::Edge(edge) => Some((edge.id.as_str(), edge.comment_chrome)),
        _ => None,
    }
}

#[must_use]
pub fn scene_entries(scene: &Scene) -> Vec<SceneEntry> {
    let mut entries = Vec::with_capacity(scene.nodes.len());
    let mut owner = "preamble";
    let mut owner_annotation = false;
    let mut ordinal: u32 = 0;
    for node in &scene.nodes {
        if let Some((id, annotation)) = identity(node) {
            owner = id;
            owner_annotation = annotation;
            ordinal = 0;
            entries.push(SceneEntry { key: id.to_string(), annotation });
        } else {
            ordinal = ordinal.saturating_add(1);
            entries.push(SceneEntry {
                key: format!("{owner}#{ordinal}"),
                annotation: owner_annotation,
            });
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::{SceneEntry, scene_entries};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_model::spatial::EdgeSide;
    use whiteboard_scene::{
        BoundingBox, EdgeEnd, GlyphSceneNode, ResolvedEdgeNode, Scene, SceneNode, ShapeSceneNode,
    };

    const BOX: BoundingBox = BoundingBox { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };

    fn shape(id: Option<&str>, comment: bool) -> SceneNode {
        SceneNode::Shape(Box::new(ShapeSceneNode {
            truncated: false,
            overflows: false,
            id: id.map(String::from),
            bbox: BOX,
            comment_chrome: comment,
            proposal_chrome: None,
            radius: None,
            shape: None,
            appearance: None,
            task_box: None,
            ink: None,
        }))
    }

    fn edge(id: &str, comment: bool) -> SceneNode {
        SceneNode::Edge(Box::new(ResolvedEdgeNode {
            id: id.into(),
            jumps: None,
            path: vec![],
            from_side: EdgeSide::Top,
            to_side: EdgeSide::Top,
            from_end: EdgeEnd::None,
            to_end: EdgeEnd::None,
            rounded: false,
            ink: None,
            comment_chrome: comment,
            appearance: None,
        }))
    }

    fn glyph() -> SceneNode {
        SceneNode::Glyph(GlyphSceneNode { bbox: BOX, glyph: "g".into() })
    }

    fn entry(key: &str, annotation: bool) -> SceneEntry {
        SceneEntry { key: key.into(), annotation }
    }

    #[test]
    fn content_after_a_chrome_shape_keys_by_its_owner_and_an_ordinal() {
        let scene = Scene {
            nodes: vec![glyph(), shape(Some("a"), false), glyph(), glyph(), edge("e", false)],
            legend: None,
        };
        assert_eq!(
            scene_entries(&scene),
            [
                entry("preamble#1", false),
                entry("a", false),
                entry("a#1", false),
                entry("a#2", false),
                entry("e", false),
            ]
        );
    }

    #[test]
    fn the_ordinal_restarts_at_each_identified_entry() {
        let scene = Scene {
            nodes: vec![shape(Some("a"), false), glyph(), shape(Some("b"), false), glyph()],
            legend: None,
        };
        let keys: Vec<String> = scene_entries(&scene).into_iter().map(|e| e.key).collect();
        assert_eq!(keys, ["a", "a#1", "b", "b#1"]);
    }

    #[test]
    fn a_shape_without_an_id_is_content_of_the_previous_owner() {
        let scene = Scene {
            nodes: vec![shape(None, true), shape(Some("a"), false), shape(None, false)],
            legend: None,
        };
        let keys: Vec<String> = scene_entries(&scene).into_iter().map(|e| e.key).collect();
        assert_eq!(keys, ["preamble#1", "a", "a#1"]);
    }

    #[test]
    fn comment_chrome_marks_its_owner_and_everything_it_owns_as_annotation() {
        let scene = Scene {
            nodes: vec![
                shape(Some("n"), false),
                shape(Some("c/pin"), true),
                glyph(),
                edge("c/leader", true),
                glyph(),
                shape(Some("m"), false),
                glyph(),
            ],
            legend: None,
        };
        let marked: Vec<bool> = scene_entries(&scene).into_iter().map(|e| e.annotation).collect();
        assert_eq!(marked, [false, true, true, true, true, false, false]);
    }
}
