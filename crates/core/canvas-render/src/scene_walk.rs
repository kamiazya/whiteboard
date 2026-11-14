//! How a scene nests, defined once: what a node holds, per variant.

use whiteboard_scene::{
    Appearance, BoundingBox, ListItemNode, SceneInk, SceneNode, TableCellSceneNode,
    TableRowSceneNode, TextRunNode,
};

/// A node reachable while walking a scene. List items, table rows and table
/// cells are not members of the `SceneNode` union (they only ever appear nested
/// under a list or a table) but a walk still has to descend into them.
#[derive(Debug, Clone, Copy)]
pub enum SceneWalk<'a> {
    Node(&'a SceneNode),
    /// A run held by a heading, a paragraph, a fenced block or a cell.
    Run(&'a TextRunNode),
    Item(&'a ListItemNode),
    Row(&'a TableRowSceneNode),
    Cell(&'a TableCellSceneNode),
}

impl<'a> SceneWalk<'a> {
    /// The nodes this one holds, in order, or none for a leaf.
    #[must_use]
    pub fn children(self) -> Vec<SceneWalk<'a>> {
        match self {
            SceneWalk::Node(node) => node_children(node),
            SceneWalk::Run(_) => Vec::new(),
            SceneWalk::Item(item) => item.children.iter().map(SceneWalk::Node).collect(),
            SceneWalk::Row(row) => row.cells.iter().map(SceneWalk::Cell).collect(),
            SceneWalk::Cell(cell) => cell.runs.iter().map(run_walk).collect(),
        }
    }

    /// The node's own box; an edge has none.
    #[must_use]
    pub fn bbox(self) -> Option<&'a BoundingBox> {
        match self {
            SceneWalk::Node(node) => node_bbox(node),
            SceneWalk::Run(run) => Some(&run.bbox),
            SceneWalk::Item(item) => Some(&item.bbox),
            SceneWalk::Row(row) => Some(&row.bbox),
            SceneWalk::Cell(cell) => Some(&cell.bbox),
        }
    }

    /// The paint a node carries, for the kinds that carry one.
    #[must_use]
    pub fn appearance(self) -> Option<&'a Appearance> {
        match self {
            SceneWalk::Node(node) => node_appearance(node),
            SceneWalk::Run(run) => run.appearance.as_ref(),
            SceneWalk::Row(row) => row.appearance.as_ref(),
            SceneWalk::Cell(cell) => cell.appearance.as_ref(),
            SceneWalk::Item(_) => None,
        }
    }

    /// The run, when this node is a text run, however it is held.
    #[must_use]
    pub fn text_run(self) -> Option<&'a TextRunNode> {
        match self {
            SceneWalk::Node(SceneNode::TextRun(run)) => Some(run),
            SceneWalk::Run(run) => Some(run),
            _ => None,
        }
    }

    /// The x-shift this node applies to its own subtree. Only a list item and
    /// a table cell emit a transform, translating by their own `x`, so their
    /// descendants are stored relative to the wrapper; every walk that wants
    /// where they are DRAWN (the scene's bounds, the passage highlights) adds
    /// this back, nested wrappers composing. A non-finite `x` contributes no
    /// shift rather than poisoning the whole subtree (`subtreeOffsetX`).
    #[must_use]
    pub fn subtree_offset_x(self) -> f64 {
        match self {
            SceneWalk::Item(ListItemNode { bbox, .. })
            | SceneWalk::Cell(TableCellSceneNode { bbox, .. })
                if bbox.x.is_finite() =>
            {
                bbox.x
            }
            _ => 0.0,
        }
    }

    /// The ink a node is drawn with, for the two kinds that take one.
    #[must_use]
    pub fn ink(self) -> Option<&'a SceneInk> {
        match self {
            SceneWalk::Node(SceneNode::Edge(edge)) => edge.ink.as_ref(),
            SceneWalk::Node(SceneNode::Shape(shape)) => shape.ink.as_ref(),
            _ => None,
        }
    }
}

fn run_walk(run: &whiteboard_scene::TextRunNode) -> SceneWalk<'_> {
    SceneWalk::Run(run)
}

fn node_children(node: &SceneNode) -> Vec<SceneWalk<'_>> {
    match node {
        SceneNode::Blockquote(n) => n.children.iter().map(SceneWalk::Node).collect(),
        SceneNode::Group(n) => n.children.iter().map(SceneWalk::Node).collect(),
        SceneNode::EmbedResolved(n) => n.children.iter().map(SceneWalk::Node).collect(),
        SceneNode::List(n) => n.items.iter().map(SceneWalk::Item).collect(),
        SceneNode::Table(n) => n.rows.iter().map(SceneWalk::Row).collect(),
        SceneNode::Heading(n) => n.runs.iter().map(run_walk).collect(),
        SceneNode::Paragraph(n) => n.runs.iter().map(run_walk).collect(),
        // A fenced block's runs are optional, and absent means no children.
        SceneNode::CodeBlock(n) => n.runs.iter().flatten().map(run_walk).collect(),
        _ => Vec::new(),
    }
}

fn node_bbox(node: &SceneNode) -> Option<&BoundingBox> {
    match node {
        SceneNode::Heading(n) => Some(&n.bbox),
        SceneNode::Paragraph(n) => Some(&n.bbox),
        SceneNode::List(n) => Some(&n.bbox),
        SceneNode::CodeBlock(n) => Some(&n.bbox),
        SceneNode::Blockquote(n) => Some(&n.bbox),
        SceneNode::ThematicBreak(n) => Some(&n.bbox),
        SceneNode::Table(n) => Some(&n.bbox),
        SceneNode::RawHtml(n) => Some(&n.bbox),
        SceneNode::UnresolvedReference(n) => Some(&n.bbox),
        SceneNode::SvgFragment(n) => Some(&n.bbox),
        SceneNode::EmbedPlaceholder(n) => Some(&n.bbox),
        SceneNode::EmbedResolved(n) => Some(&n.bbox),
        SceneNode::Group(n) => Some(&n.bbox),
        SceneNode::TextRun(n) => Some(&n.bbox),
        SceneNode::Shape(n) => Some(&n.bbox),
        SceneNode::Image(n) => Some(&n.bbox),
        SceneNode::Icon(n) => Some(&n.bbox),
        SceneNode::Glyph(n) => Some(&n.bbox),
        SceneNode::Edge(_) => None,
    }
}

fn node_appearance(node: &SceneNode) -> Option<&Appearance> {
    match node {
        SceneNode::TextRun(n) => n.appearance.as_ref(),
        SceneNode::Shape(n) => n.appearance.as_ref(),
        SceneNode::Icon(n) => n.appearance.as_ref(),
        SceneNode::CodeBlock(n) => n.appearance.as_ref(),
        SceneNode::Blockquote(n) => n.appearance.as_ref(),
        SceneNode::ThematicBreak(n) => n.appearance.as_ref(),
        SceneNode::Edge(n) => n.appearance.as_ref(),
        _ => None,
    }
}
