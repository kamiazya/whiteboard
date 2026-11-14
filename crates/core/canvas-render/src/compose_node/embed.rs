//! A canvas drawn inside another document: a file node's referenced canvas
//! (`composeFileEmbed`), and a body's `![[canvas]]` (`layoutCanvasMiniature`).
//! Both are the canvas laid out at its own size by the composer's walk, then
//! fitted into the box they have; neither is ever scaled up.

use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};
use whiteboard_scene::{BoundingBox, EmbedResolvedNode, SceneNode};

use super::ComposeOptions;
use crate::compose_canvas::layout_nested_canvas;
use crate::node_box::ResolvedReference;
use crate::scale_scene::fit_scene_into_box;
use crate::typeset::{CanvasMiniature, EmbedBox, Miniature};
use whiteboard_model::node_content::node_file;

/// The top-level canvas is depth 0, so a fourth level is refused: the cap a
/// body's embeds are held to, so neither kind of embed nests deeper.
const DEPTH_CAP: usize = 3;

/// What a canvas charges the nested-layout account: its nodes, edges and lines.
fn element_count(canvas: &SpatialCanvas) -> usize {
    let lines = canvas.lines.as_ref().map_or(0, Vec::len);
    canvas.nodes.len().saturating_add(canvas.edges.len()).saturating_add(lines)
}

/// `options` for the canvas entered, `path` already holding it. The walk takes
/// the canvas's depth from its path.
fn nested<'a>(options: &ComposeOptions<'a>, path: &'a [String]) -> ComposeOptions<'a> {
    ComposeOptions { embed_path: path, ..*options }
}

/// The file node's referenced canvas, scaled into the node's padded box under an
/// `embedResolved` the size of the node. None whenever the card should be drawn
/// instead: no canvas, the expansion policy keeps it closed, the depth cap, the
/// canvas already on the path being laid out, the render's account refusing it,
/// or a box with no room — which is found only after the account was spent, as
/// the TypeScript spends it.
pub(super) fn compose_file_embed(
    node: &SpatialNode,
    resolved: Option<&ResolvedReference>,
    options: &ComposeOptions<'_>,
) -> Option<SceneNode> {
    let child = resolved?.canvas.as_ref()?;
    if !options.layout.host.expand_file_node(node) {
        return None;
    }
    let file = node_file(node)?;
    if options.embed_depth >= DEPTH_CAP
        || options.embed_path.iter().any(|entered| entered == file)
        || !options.budget.spend(element_count(child))
    {
        return None;
    }
    let mut path = options.embed_path.to_vec();
    path.push(file.to_owned());
    let inner = nested(options, &path);
    let laid = layout_nested_canvas(child, &inner);
    let padding = options.node_box.geometry.padding_px;
    // The name is drawn above the frame, so the canvas takes the whole padded box.
    let space = EmbedBox {
        x: node.x + padding,
        y: node.y + padding,
        max_width: node.width - 2.0 * padding,
        max_height: node.height - 2.0 * padding,
    };
    let fitted = fit_scene_into_box(&laid, &space)?;
    Some(SceneNode::EmbedResolved(EmbedResolvedNode {
        bbox: BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height },
        document_id: file.to_owned(),
        children: fitted.nodes,
    }))
}

/// A body's canvas embed, drawn by the composer that lays the body out: the
/// canvas laid out with the same seams as the one the body sits in, on the path
/// the typesetter hands back, and fitted into the box it reserved.
impl CanvasMiniature for ComposeOptions<'_> {
    fn miniature(
        &self,
        document_id: &str,
        fragment: Option<&str>,
        space: &EmbedBox,
        path: &[String],
    ) -> Option<Miniature> {
        let canvas = self.layout.host.embedded_canvas(document_id, fragment)?;
        let laid = layout_nested_canvas(&canvas, &nested(self, path));
        fit_scene_into_box(&laid, space)
    }
}
