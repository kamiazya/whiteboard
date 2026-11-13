//! What is drawn over a node after its own content (`composeDecorations`):
//! every contribution's decorations, asked in order. The renderer names no
//! plugin; the bundled visual plugin's `StencilBadge` is the contribution a
//! composer passes by default, as the TypeScript's default contributions are
//! the visual plugin's.

use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{DecorationContext, NodeDecoration, SceneNode};

use crate::node_box::{NodeBoxOptions, node_content_bounds};

/// Every decoration over `node`, in contribution order, each told the node's
/// content bounds and the label's appearance, which is what a mark that should
/// match the node's text is inked with.
#[must_use]
pub fn compose_decorations(
    node: &SpatialNode,
    options: &NodeBoxOptions<'_>,
    contributions: &[&dyn NodeDecoration],
) -> Vec<SceneNode> {
    let context = DecorationContext {
        bounds: node_content_bounds(node, options),
        label: options.appearance.resolve_label(),
    };
    contributions.iter().flat_map(|decoration| decoration.decorate(node, &context)).collect()
}
