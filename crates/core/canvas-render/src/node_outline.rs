//! A node's silhouette, resolved from the shape table.
//!
//! The ONE producer of non-rect node silhouettes, so the backend draws the
//! outline the plugin decomposes and hit-testing and edge anchoring answer
//! against the same decomposition. The table is the bundled visual plugin's
//! (`whiteboard_plugin_visual::render`), always; a caller-supplied table is not
//! ported.

use crate::finite_box::is_finite_box;
use whiteboard_plugin_visual::render::{shape_content_box, shape_outline};
use whiteboard_scene::{BoundingBox, NodeOutline};

/// The outline of silhouette `shape_id` in `bbox`. An unknown id degrades to
/// none, a plain rect, like any other malformed input: the value arrives from a
/// stored facet payload, and a document naming a shape this build does not
/// carry is ordinary. A box with a non-finite field has no outline either.
#[must_use]
pub fn node_outline(shape_id: &str, bbox: &BoundingBox) -> Option<NodeOutline> {
    if !is_finite_box(bbox) {
        return None;
    }
    shape_outline(shape_id, bbox)
}

/// The axis-aligned box inside silhouette `shape_id` where a node's content can
/// lay out without crossing it. No silhouette, an unknown one, or a box with a
/// non-finite field is its own content box, per [`node_outline`]'s none.
#[must_use]
pub fn outline_content_box(shape_id: Option<&str>, bbox: &BoundingBox) -> BoundingBox {
    shape_id
        .filter(|_| is_finite_box(bbox))
        .and_then(|id| shape_content_box(id, bbox))
        .unwrap_or(*bbox)
}
