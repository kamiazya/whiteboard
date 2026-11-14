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
