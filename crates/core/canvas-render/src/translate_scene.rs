//! Scene-to-scene translation (`layout/translate-scene.ts`): a node's content is
//! laid out relative to its own origin, and placing it at the node's position
//! shifts the whole tree.
//!
//! The x axis needs care. A list item and a table cell are the only wrappers the
//! SVG backend draws with `transform="translate(bbox.x,0)"`, so everything below
//! one is stored wrapper-RELATIVE on x: shifting it too would move it twice. So
//! x shifts down to, and including, the nearest such wrapper and no further,
//! exactly as [`crate::scene_bounds`]'s offset walk reads it. No wrapper
//! transforms y, so y shifts at every depth.
//!
//! A coordinate that does not move is still added a zero, as the TypeScript adds
//! one: `-0 + 0` is `+0`, and the recording holds that.

use whiteboard_scene::{BoundingBox, ListItemNode, SceneNode, TableRowSceneNode, TextRunNode};

#[derive(Clone, Copy)]
struct Shift {
    dx: f64,
    dy: f64,
}

impl Shift {
    /// The shift below an x-transform wrapper: y only.
    const fn below_wrapper(self) -> Self {
        Self { dx: 0.0, dy: self.dy }
    }

    fn bbox(self, bbox: &mut BoundingBox) {
        bbox.x += self.dx;
        bbox.y += self.dy;
    }

    fn runs(self, runs: &mut [TextRunNode]) {
        for run in runs {
            self.bbox(&mut run.bbox);
        }
    }

    fn item(self, item: &mut ListItemNode) {
        self.bbox(&mut item.bbox);
        let inner = self.below_wrapper();
        for child in &mut item.children {
            inner.node(child);
        }
    }

    fn row(self, row: &mut TableRowSceneNode) {
        self.bbox(&mut row.bbox);
        let inner = self.below_wrapper();
        for cell in &mut row.cells {
            self.bbox(&mut cell.bbox);
            inner.runs(&mut cell.runs);
        }
    }

    fn node(self, node: &mut SceneNode) {
        match node {
            SceneNode::Edge(edge) => {
                for point in &mut edge.path {
                    point.x += self.dx;
                    point.y += self.dy;
                }
                for jump in edge.jumps.iter_mut().flatten() {
                    jump.x += self.dx;
                    jump.y += self.dy;
                }
            }
            SceneNode::Blockquote(n) => self.children(&mut n.bbox, &mut n.children),
            SceneNode::Group(n) => self.children(&mut n.bbox, &mut n.children),
            SceneNode::EmbedResolved(n) => self.children(&mut n.bbox, &mut n.children),
            SceneNode::Heading(n) => {
                self.bbox(&mut n.bbox);
                self.runs(&mut n.runs);
            }
            SceneNode::Paragraph(n) => {
                self.bbox(&mut n.bbox);
                self.runs(&mut n.runs);
            }
            SceneNode::CodeBlock(n) => {
                self.bbox(&mut n.bbox);
                self.runs(n.runs.as_deref_mut().unwrap_or_default());
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
            leaf => self.leaf(leaf),
        }
    }

    /// A node that holds nothing and is not an edge: only its box moves.
    fn leaf(self, node: &mut SceneNode) {
        let bbox = match node {
            SceneNode::ThematicBreak(n) => &mut n.bbox,
            SceneNode::RawHtml(n) => &mut n.bbox,
            SceneNode::UnresolvedReference(n) => &mut n.bbox,
            SceneNode::SvgFragment(n) => &mut n.bbox,
            SceneNode::EmbedPlaceholder(n) => &mut n.bbox,
            SceneNode::TextRun(n) => &mut n.bbox,
            SceneNode::Shape(n) => &mut n.bbox,
            SceneNode::Image(n) => &mut n.bbox,
            SceneNode::Icon(n) => &mut n.bbox,
            SceneNode::Glyph(n) => &mut n.bbox,
            // Every other kind is moved by `node` with what it holds.
            _ => return,
        };
        self.bbox(bbox);
    }

    fn children(self, bbox: &mut BoundingBox, children: &mut [SceneNode]) {
        self.bbox(bbox);
        for child in children {
            self.node(child);
        }
    }
}

/// `nodes` moved by `(dx, dy)`, every field that is not geometry kept.
#[must_use]
pub fn translate_scene(nodes: &[SceneNode], dx: f64, dy: f64) -> Vec<SceneNode> {
    let mut moved = nodes.to_vec();
    for node in &mut moved {
        Shift { dx, dy }.node(node);
    }
    moved
}
