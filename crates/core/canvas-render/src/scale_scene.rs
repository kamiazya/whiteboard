//! A laid-out scene fitted into a box (`layout/scale-scene.ts`): moved to the
//! origin, scaled down uniformly about it, and moved to the box's corner. A
//! canvas drawn inside a file node and one drawn inside a body's embed are the
//! same picture in two frames, so both are fitted here.
//!
//! Scaling needs no x-transform-wrapper case, unlike translation: a list item's
//! and a table cell's children are stored relative to the wrapper, and a uniform
//! scale about the origin commutes with that (`f * (wrapper + relative)`).
//!
//! The paint that has a size scales with the geometry (a font size, a stroke
//! width, a corner radius, a baseline), so a miniature reads as a miniature
//! rather than as full-weight strokes on shrunken boxes. An SVG fragment's
//! source, an icon's own stroke and an edge's arrowheads do not, by design.

use whiteboard_scene::{
    Appearance, BoundingBox, ListItemNode, Scene, SceneNode, TableRowSceneNode, TextRunNode,
};

use crate::scene_bounds::scene_bounds;
use crate::translate_scene::translate_scene;
use whiteboard_det::math::js_min;

use crate::typeset::{EmbedBox, Miniature};

#[derive(Clone, Copy)]
struct Factor(f64);

impl Factor {
    fn bbox(self, bbox: &mut BoundingBox) {
        bbox.x *= self.0;
        bbox.y *= self.0;
        bbox.w *= self.0;
        bbox.h *= self.0;
    }

    fn appearance(self, appearance: Option<&mut Appearance>) {
        let Some(appearance) = appearance else { return };
        for size in [&mut appearance.font_size, &mut appearance.stroke_width].into_iter().flatten()
        {
            *size *= self.0;
        }
    }

    fn runs(self, runs: &mut [TextRunNode]) {
        for run in runs {
            self.bbox(&mut run.bbox);
            if let Some(baseline) = &mut run.baseline {
                *baseline *= self.0;
            }
            self.appearance(run.appearance.as_mut());
        }
    }

    fn item(self, item: &mut ListItemNode) {
        self.bbox(&mut item.bbox);
        self.nodes(&mut item.children);
    }

    fn row(self, row: &mut TableRowSceneNode) {
        self.bbox(&mut row.bbox);
        for cell in &mut row.cells {
            self.bbox(&mut cell.bbox);
            self.runs(&mut cell.runs);
        }
    }

    fn nodes(self, nodes: &mut [SceneNode]) {
        for node in nodes {
            self.node(node);
        }
    }

    fn node(self, node: &mut SceneNode) {
        match node {
            SceneNode::Edge(edge) => {
                for point in &mut edge.path {
                    point.x *= self.0;
                    point.y *= self.0;
                }
                for jump in edge.jumps.iter_mut().flatten() {
                    jump.x *= self.0;
                    jump.y *= self.0;
                }
                self.appearance(edge.appearance.as_mut());
            }
            SceneNode::TextRun(run) => self.runs(std::slice::from_mut(&mut **run)),
            SceneNode::Shape(shape) => {
                self.bbox(&mut shape.bbox);
                if let Some(radius) = &mut shape.radius {
                    *radius *= self.0;
                }
                self.appearance(shape.appearance.as_mut());
            }
            SceneNode::Heading(n) => self.block(&mut n.bbox, &mut n.runs),
            SceneNode::Paragraph(n) => self.block(&mut n.bbox, &mut n.runs),
            SceneNode::CodeBlock(n) => {
                self.block(&mut n.bbox, n.runs.as_deref_mut().unwrap_or_default());
            }
            SceneNode::List(n) => {
                self.bbox(&mut n.bbox);
                for item in &mut n.items {
                    self.item(item);
                }
            }
            SceneNode::Table(n) => {
                self.bbox(&mut n.bbox);
                for row in &mut n.rows {
                    self.row(row);
                }
            }
            SceneNode::Blockquote(n) => self.container(&mut n.bbox, &mut n.children),
            SceneNode::EmbedResolved(n) => self.container(&mut n.bbox, &mut n.children),
            SceneNode::Group(n) => self.container(&mut n.bbox, &mut n.children),
            leaf => self.leaf(leaf),
        }
    }

    fn block(self, bbox: &mut BoundingBox, runs: &mut [TextRunNode]) {
        self.bbox(bbox);
        self.runs(runs);
    }

    fn container(self, bbox: &mut BoundingBox, children: &mut [SceneNode]) {
        self.bbox(bbox);
        self.nodes(children);
    }

    /// A node that holds nothing and paints nothing with a size: its box alone.
    fn leaf(self, node: &mut SceneNode) {
        let bbox = match node {
            SceneNode::ThematicBreak(n) => &mut n.bbox,
            SceneNode::RawHtml(n) => &mut n.bbox,
            SceneNode::UnresolvedReference(n) => &mut n.bbox,
            SceneNode::SvgFragment(n) => &mut n.bbox,
            SceneNode::EmbedPlaceholder(n) => &mut n.bbox,
            SceneNode::Image(n) => &mut n.bbox,
            SceneNode::Icon(n) => &mut n.bbox,
            SceneNode::Glyph(n) => &mut n.bbox,
            // Every other kind is scaled by `node` with what it holds.
            _ => return,
        };
        self.bbox(bbox);
    }
}

/// `nodes` fitted into `space` (`fitSceneIntoBox`): scaled to fit, never up, and
/// placed at its top-left corner. None for a fit with no room, which a box with
/// no width or height, or a non-finite one, leaves; the caller draws its
/// fallback. The scale is then finite and in `(0, 1]`, so the TypeScript's
/// `scaleScene` guards against any other factor have nothing to catch here.
#[must_use]
pub fn fit_scene_into_box(nodes: &[SceneNode], space: &EmbedBox) -> Option<Miniature> {
    let bounds = scene_bounds(&Scene { nodes: nodes.to_vec(), legend: None });
    let fit = js_min(js_min(space.max_width / bounds.w, space.max_height / bounds.h), 1.0);
    if !(fit.is_finite() && fit > 0.0) {
        return None;
    }
    let mut placed = translate_scene(nodes, -bounds.x, -bounds.y);
    Factor(fit).nodes(&mut placed);
    Some(Miniature {
        nodes: translate_scene(&placed, space.x, space.y),
        w: bounds.w * fit,
        h: bounds.h * fit,
    })
}
