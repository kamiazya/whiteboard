//! The annotation layer as the canvas reads it (`packages/model/src/annotation.ts`,
//! ADR-0026): a thread, where it points, and the comment a canvas draws for it.
//!
//! Plain data, like [`crate::mdast`]: the zod schema is the contract, and a
//! thread reaches this crate already read. Only what a layout reads is held — a
//! message's author and timestamps, and a text anchor's quote and offsets, stay
//! with the TypeScript until something here reads them.

use whiteboard_det::math::{js_max, js_min};

use crate::spatial::{CanvasPoint, SpatialNode};

/// A spatial anchor: a point, optionally about a node, an edge or a node set,
/// and a region when it has a size.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SpatialAnchor {
    pub node_id: Option<String>,
    pub edge_id: Option<String>,
    /// Several nodes at once, in the order the selection named them.
    pub node_ids: Option<Vec<String>>,
    pub x: f64,
    pub y: f64,
    /// With `height`, the anchor is a region with `x`/`y` its top-left corner.
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// Where a thread points (`annotationAnchorSchema`).
#[derive(Debug, Clone, PartialEq)]
pub enum AnnotationAnchor {
    Spatial(SpatialAnchor),
    /// A passage: of a text node's text when it names one, else of a note's body.
    Text {
        node_id: Option<String>,
    },
    /// The document as a whole, which has no place on any surface.
    Document,
}

/// One message of a thread.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CommentMessage {
    pub id: String,
    pub body: String,
}

/// A conversation anchored somewhere (`commentThreadSchema`), its messages in
/// the order `compareMessages` puts them.
#[derive(Debug, Clone, PartialEq)]
pub struct CommentThread {
    pub id: String,
    pub anchor: AnnotationAnchor,
    pub resolved: bool,
    pub messages: Vec<CommentMessage>,
}

/// An axis-aligned rectangle in canvas coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnchorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A thread as the canvas draws it (`CanvasComment`): the opening message at a
/// point, about a node or an edge when the anchor names one. Unrounded, like
/// the node geometry it is read from.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlacedComment {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub target_node_id: Option<String>,
    pub target_edge_id: Option<String>,
    pub resolved: bool,
}

/// The smallest box covering every node (`boundsOf`); none for no nodes. A NaN
/// edge spreads, as `Math.min` and `Math.max` spread it.
#[must_use]
pub fn bounds_of(nodes: &[&SpatialNode]) -> Option<AnchorRect> {
    if nodes.is_empty() {
        return None;
    }
    let (mut left, mut top) = (f64::INFINITY, f64::INFINITY);
    let (mut right, mut bottom) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for node in nodes {
        left = js_min(left, node.x);
        top = js_min(top, node.y);
        right = js_max(right, node.x + node.width);
        bottom = js_max(bottom, node.y + node.height);
    }
    Some(AnchorRect { x: left, y: top, width: right - left, height: bottom - top })
}

/// The rectangle a spatial anchor stands for (`spatialAnchorRect`): the bounds
/// of whichever of its nodes still exist, else the region it stored. None for a
/// point, node or edge anchor, which stand for no area.
pub fn spatial_anchor_rect<'n>(
    anchor: &SpatialAnchor,
    node_by_id: impl Fn(&str) -> Option<&'n SpatialNode>,
) -> Option<AnchorRect> {
    if let Some(ids) = &anchor.node_ids {
        let live: Vec<&SpatialNode> = ids.iter().filter_map(|id| node_by_id(id)).collect();
        if let Some(bounds) = bounds_of(&live) {
            return Some(bounds);
        }
    }
    let (Some(width), Some(height)) = (anchor.width, anchor.height) else { return None };
    Some(AnchorRect { x: anchor.x, y: anchor.y, width, height })
}

/// Where a comment on a box pins (`commentCornerOf`): its top-right corner, so
/// the pin sits outside what it is about.
#[must_use]
pub fn comment_corner_of(x: f64, y: f64, width: f64) -> CanvasPoint {
    CanvasPoint { x: x + width, y }
}

/// The first node holding `id`, as a scan from the front answers.
fn first_with<'n>(nodes: &'n [SpatialNode], id: &str) -> Option<&'n SpatialNode> {
    nodes.iter().find(|node| node.id == id)
}

/// One thread as the canvas sees it (`canvasCommentFromThread`): its opening
/// message where `commentPlace` stands it. A node set or region stands at the
/// corner of its rect, a passage of a node at the node's corner; a note's
/// passage, a node that is gone and the document stand nowhere.
fn project(thread: &CommentThread, nodes: &[SpatialNode]) -> Option<PlacedComment> {
    let opening = thread.messages.first()?;
    let at = |corner: CanvasPoint| PlacedComment {
        id: thread.id.clone(),
        x: corner.x,
        y: corner.y,
        text: opening.body.clone(),
        resolved: thread.resolved,
        ..PlacedComment::default()
    };
    match &thread.anchor {
        AnnotationAnchor::Document => None,
        AnnotationAnchor::Spatial(spatial) => {
            Some(match spatial_anchor_rect(spatial, |id| first_with(nodes, id)) {
                Some(rect) => at(comment_corner_of(rect.x, rect.y, rect.width)),
                None => PlacedComment {
                    target_node_id: spatial.node_id.clone(),
                    target_edge_id: spatial.edge_id.clone(),
                    ..at(CanvasPoint { x: spatial.x, y: spatial.y })
                },
            })
        }
        AnnotationAnchor::Text { node_id } => {
            let node = first_with(nodes, node_id.as_deref()?)?;
            let corner = comment_corner_of(node.x, node.y, node.width);
            Some(PlacedComment { target_node_id: Some(node.id.clone()), ..at(corner) })
        }
    }
}

/// Every thread with a place on this canvas, as the comment its pin is drawn
/// from (`canvasCommentsOf`), in the order the threads arrive: that order
/// decides which bubble yields to which. A thread about the document, a note's
/// passage or a node that is gone has no pin.
#[must_use]
pub fn canvas_comments_of(threads: &[CommentThread], nodes: &[SpatialNode]) -> Vec<PlacedComment> {
    threads.iter().filter_map(|thread| project(thread, nodes)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn node(id: &str, x: f64, y: f64, width: f64, height: f64) -> SpatialNode {
        SpatialNode { id: id.to_owned(), x, y, width, height, ..SpatialNode::default() }
    }

    fn thread(id: &str, anchor: AnnotationAnchor) -> CommentThread {
        CommentThread {
            id: id.to_owned(),
            anchor,
            resolved: false,
            messages: vec![
                CommentMessage { id: "m1".to_owned(), body: "first".to_owned() },
                CommentMessage { id: "m2".to_owned(), body: "second".to_owned() },
            ],
        }
    }

    fn spatial(anchor: SpatialAnchor) -> AnnotationAnchor {
        AnnotationAnchor::Spatial(anchor)
    }

    #[test]
    fn bounds_cover_every_node_and_none_covers_nothing() {
        let a = node("a", 10.0, 20.0, 30.0, 40.0);
        let b = node("b", -5.0, 50.0, 10.0, 5.0);
        assert_eq!(bounds_of(&[]), None);
        assert_eq!(
            bounds_of(&[&a, &b]),
            Some(AnchorRect { x: -5.0, y: 20.0, width: 45.0, height: 40.0 })
        );
        let nan = node("n", f64::NAN, 0.0, 1.0, 1.0);
        let bounds = bounds_of(&[&a, &nan]).unwrap();
        assert!(bounds.x.is_nan() && bounds.width.is_nan());
        assert_eq!((bounds.y, bounds.height), (0.0, 60.0));
    }

    #[test]
    fn a_node_set_stands_for_its_live_nodes_then_for_its_stored_region() {
        let nodes = [node("a", 0.0, 0.0, 10.0, 10.0), node("b", 20.0, 30.0, 10.0, 10.0)];
        let by_id = |id: &str| first_with(&nodes, id);
        let set = |ids: &[&str], size: Option<f64>| SpatialAnchor {
            node_ids: Some(ids.iter().map(|id| (*id).to_owned()).collect()),
            x: 1.0,
            y: 2.0,
            width: size,
            height: size,
            ..SpatialAnchor::default()
        };
        let live = AnchorRect { x: 0.0, y: 0.0, width: 30.0, height: 40.0 };
        assert_eq!(spatial_anchor_rect(&set(&["a", "b", "gone"], Some(5.0)), by_id), Some(live));
        let stored = AnchorRect { x: 1.0, y: 2.0, width: 5.0, height: 5.0 };
        assert_eq!(spatial_anchor_rect(&set(&["gone"], Some(5.0)), by_id), Some(stored));
        assert_eq!(spatial_anchor_rect(&set(&["gone"], None), by_id), None);
        let half = SpatialAnchor { width: Some(5.0), ..SpatialAnchor::default() };
        assert_eq!(spatial_anchor_rect(&half, by_id), None);
        let other_half = SpatialAnchor { height: Some(5.0), ..SpatialAnchor::default() };
        assert_eq!(spatial_anchor_rect(&other_half, by_id), None);
    }

    #[test]
    fn every_arm_projects_or_says_why_not() {
        let nodes = [
            node("n", 10.0, 20.0, 100.0, 50.0),
            node("n", 900.0, 900.0, 1.0, 1.0),
            node("m", 0.0, 0.0, 5.0, 5.0),
        ];
        let point = SpatialAnchor {
            node_id: Some("gone".to_owned()),
            edge_id: Some("e".to_owned()),
            x: 3.0,
            y: 4.0,
            ..SpatialAnchor::default()
        };
        let region = SpatialAnchor {
            node_ids: Some(vec!["n".to_owned(), "m".to_owned()]),
            node_id: Some("ignored".to_owned()),
            ..SpatialAnchor::default()
        };
        let mut settled = thread("settled", spatial(SpatialAnchor::default()));
        settled.resolved = true;
        let silent =
            CommentThread { messages: Vec::new(), ..thread("silent", spatial(point.clone())) };
        let threads = [
            thread("doc", AnnotationAnchor::Document),
            thread("point", spatial(point)),
            thread("region", spatial(region)),
            thread("passage", AnnotationAnchor::Text { node_id: Some("n".to_owned()) }),
            thread("orphan", AnnotationAnchor::Text { node_id: Some("gone".to_owned()) }),
            thread("note", AnnotationAnchor::Text { node_id: None }),
            silent,
            settled,
        ];
        let placed = canvas_comments_of(&threads, &nodes);
        let at = |c: &PlacedComment| {
            (c.id.clone(), c.x, c.y, c.target_node_id.clone(), c.target_edge_id.clone())
        };
        assert_eq!(
            placed.iter().map(at).collect::<Vec<_>>(),
            [
                ("point".to_owned(), 3.0, 4.0, Some("gone".to_owned()), Some("e".to_owned())),
                ("region".to_owned(), 110.0, 0.0, None, None),
                ("passage".to_owned(), 110.0, 20.0, Some("n".to_owned()), None),
                ("settled".to_owned(), 0.0, 0.0, None, None),
            ]
        );
        assert!(placed.iter().all(|c| c.text == "first"));
        assert_eq!(
            placed.iter().map(|c| c.resolved).collect::<Vec<_>>(),
            [false, false, false, true]
        );
        assert_eq!(canvas_comments_of(&[], &nodes), []);
    }
}
