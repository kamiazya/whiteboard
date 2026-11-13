//! What is drawn over a node after its own content (`composeDecorations`): the
//! bundled visual plugin's stencil badge, the one decoration there is. The
//! plugin decides what the badge is; which stencil and symbol a node wears is
//! asked of the host, since their facet readers live with the composer.

use whiteboard_model::spatial::SpatialNode;
use whiteboard_plugin_visual::render::stencil_badge;
use whiteboard_plugin_visual::visual::VisualSymbolFacet;
use whiteboard_scene::{BoundingBox, SceneNode};

use crate::theme::appearance::SpatialAppearanceResolver;

/// The facet values a decoration reads off a node.
pub trait NodeMarks {
    /// The stencil the node wears (`visual.stencil/v0`), by id.
    fn stencil(&self, node: &SpatialNode) -> Option<String>;

    /// The symbol the node wears (`visual.symbol/v0`).
    fn symbol(&self, node: &SpatialNode) -> Option<VisualSymbolFacet>;
}

/// Every decoration over `node`, in contribution order; the label's appearance
/// is what a mark that should match the node's text is inked with.
#[must_use]
pub fn compose_decorations(
    node: &SpatialNode,
    appearance: &dyn SpatialAppearanceResolver,
    marks: &dyn NodeMarks,
) -> Vec<SceneNode> {
    let label = appearance.resolve_label();
    let bbox = BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height };
    let stencil = marks.stencil(node);
    let symbol = marks.symbol(node);
    stencil_badge(&bbox, stencil.as_deref(), symbol.as_ref(), label.fill.as_deref())
        .map(SceneNode::Icon)
        .into_iter()
        .collect()
}
