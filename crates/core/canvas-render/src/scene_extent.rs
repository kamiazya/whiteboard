//! How far right and down a laid-out block reaches from its own origin
//! (`layout/scene-extent.ts`): what a bubble is sized around. An edge reaches
//! nothing, its extent being its route, which a bubble never wraps.

use whiteboard_det::math::js_max;
use whiteboard_scene::{BoundingBox, SceneNode};

use crate::scene_walk::SceneWalk;

/// How far a block reaches from its origin.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Extent {
    pub right: f64,
    pub bottom: f64,
}

/// The furthest right and bottom of `nodes`' own boxes, never less than zero.
/// A NaN spreads, as `Math.max` spreads it.
#[must_use]
pub fn content_extent(nodes: &[SceneNode]) -> Extent {
    let reach = |far: fn(&BoundingBox) -> f64| {
        nodes
            .iter()
            .filter_map(|node| SceneWalk::Node(node).bbox())
            .fold(0.0, |most, bbox| js_max(most, far(bbox)))
    };
    Extent { right: reach(|b| b.x + b.w), bottom: reach(|b| b.y + b.h) }
}
