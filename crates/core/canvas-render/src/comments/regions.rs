//! The box a node set or region thread stands for (`regionsOf`), and the dashed
//! outline drawn around it so its pin has something to point at
//! (`composeRegionOutlines`).

use whiteboard_model::annotation::{
    AnchorRect, AnnotationAnchor, CommentThread, spatial_anchor_rect,
};
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};
use whiteboard_scene::{BoundingBox, SceneNode};

use super::chrome_shape;
use crate::theme::appearance::SpatialCommentAppearance;

/// Outline radius: the pin's family.
const REGION_OUTLINE_RADIUS_PX: f64 = 6.0;

/// A thread standing for a box on this canvas.
pub(super) struct Region {
    pub(super) thread_id: String,
    pub(super) rect: AnchorRect,
    pub(super) resolved: bool,
}

/// Every spatial thread standing for a box, resolved ones included, in thread
/// order. A repeated thread id keeps its first place and its last box, as a map
/// keyed by id would; the first node holding an id answers for it.
pub(super) fn regions_of(threads: &[CommentThread], canvas: &SpatialCanvas) -> Vec<Region> {
    let node_by_id =
        |id: &str| -> Option<&SpatialNode> { canvas.nodes.iter().find(|node| node.id == id) };
    let mut out: Vec<Region> = Vec::new();
    for thread in threads {
        let AnnotationAnchor::Spatial(anchor) = &thread.anchor else { continue };
        let Some(rect) = spatial_anchor_rect(anchor, node_by_id) else { continue };
        let region = Region { thread_id: thread.id.clone(), rect, resolved: thread.resolved };
        match out.iter_mut().find(|held| held.thread_id == thread.id) {
            Some(held) => *held = region,
            None => out.push(region),
        }
    }
    out
}

/// One outline per region, `<thread>/region`: a settled one drawn muted under
/// `show_resolved`, otherwise not at all.
pub(super) fn region_outlines(
    regions: &[Region],
    show_resolved: bool,
    chrome: Option<&SpatialCommentAppearance>,
) -> Vec<SceneNode> {
    regions
        .iter()
        .filter(|region| !region.resolved || show_resolved)
        .map(|region| {
            let appearance = chrome.and_then(|c| {
                if region.resolved {
                    c.resolved_overlay.region.clone()
                } else {
                    c.chrome.region.clone()
                }
            });
            let AnchorRect { x, y, width, height } = region.rect;
            let bbox = BoundingBox { x, y, w: width, h: height };
            chrome_shape(
                format!("{}/region", region.thread_id),
                bbox,
                REGION_OUTLINE_RADIUS_PX,
                appearance,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::regions_of;
    use whiteboard_model::annotation::{
        AnnotationAnchor, CommentMessage, CommentThread, SpatialAnchor,
    };
    use whiteboard_model::spatial::SpatialCanvas;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn region(id: &str, x: f64, resolved: bool) -> CommentThread {
        CommentThread {
            id: id.to_owned(),
            anchor: AnnotationAnchor::Spatial(SpatialAnchor {
                x,
                width: Some(1.0),
                height: Some(1.0),
                ..SpatialAnchor::default()
            }),
            resolved,
            messages: vec![CommentMessage::default()],
        }
    }

    #[test]
    fn a_repeated_thread_keeps_its_first_place_and_its_last_box() {
        let threads = [region("a", 1.0, false), region("b", 2.0, false), region("a", 3.0, true)];
        let held: Vec<(String, f64, bool)> = regions_of(&threads, &SpatialCanvas::default())
            .into_iter()
            .map(|r| (r.thread_id, r.rect.x, r.resolved))
            .collect();
        assert_eq!(held, [("a".to_owned(), 3.0, true), ("b".to_owned(), 2.0, false)]);
    }
}
