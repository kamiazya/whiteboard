//! What the edge layer reads of a canvas: the nodes' boxes and the routable
//! elements' ends and bends, the narrow input ADR-0054 gives this crate.
//!
//! The edge layer reads only `id`, `x`, `y`, `width` and `height` of a node,
//! and `id`, `from`, `to` and `bends` of an edge or line (`edge.path` and
//! the rest are never touched). So this is that subset, not the model.
//!
//! Ids arrive INTERNED: the caller maps each distinct id string to one
//! integer, so two equal strings are one id here. That matters because the
//! TypeScript resolves an end two ways, and both are kept:
//! - `rectAtEnd` takes the FIRST node with the id;
//! - `nodeAtEnd` reads a map built from the node list, which keeps the LAST.
//!
//! The boundary decoding these from typed arrays is ADR-0054 decision 9's
//! declared fast path, which is why there is no generated contract.

use crate::edge_geometry::Side;
use crate::geometry::{Point, Rect};

/// An interned node id.
pub type NodeId = u32;

/// An interned edge id.
pub type EdgeId = u32;

/// A node as the edge layer sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoutingNode {
    pub id: NodeId,
    pub rect: Rect,
}

/// The arrowhead at an end, as the model's `'none' | 'arrow'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arrowhead {
    None,
    Arrow,
}

/// One end of an edge or line. An edge's end always names a node; a line's
/// can be a bare point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RoutingEnd {
    Node { node: NodeId, side: Option<Side>, arrowhead: Option<Arrowhead> },
    Point { point: Point, arrowhead: Option<Arrowhead> },
}

impl RoutingEnd {
    /// The node this end names, as `endNode`.
    #[must_use]
    pub const fn node(&self) -> Option<NodeId> {
        match self {
            Self::Node { node, .. } => Some(*node),
            Self::Point { .. } => None,
        }
    }

    /// The side this end is pinned to, as `endSide`.
    #[must_use]
    pub const fn side(&self) -> Option<Side> {
        match self {
            Self::Node { side, .. } => *side,
            Self::Point { .. } => None,
        }
    }

    /// The arrowhead it asks for, as `end.end`.
    #[must_use]
    pub const fn arrowhead(&self) -> Option<Arrowhead> {
        match self {
            Self::Node { arrowhead, .. } | Self::Point { arrowhead, .. } => *arrowhead,
        }
    }
}

/// An edge or a line: what `RoutableElement` names.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutableEdge {
    pub id: EdgeId,
    pub from: RoutingEnd,
    pub to: RoutingEnd,
    /// `bends`, which the model stores as absent or non-empty.
    pub bends: Option<Vec<Point>>,
}

impl RoutableEdge {
    /// Both ends on the same node, as `isSelfLoop`: two free ends are not one.
    #[must_use]
    pub fn is_self_loop(&self) -> bool {
        self.from.node().is_some_and(|from| Some(from) == self.to.node())
    }
}

/// The box an end is anchored to, as `rectAtEnd`: the FIRST node with the
/// id, or the degenerate box at a free point.
#[must_use]
pub fn rect_at_end(nodes: &[RoutingNode], end: &RoutingEnd) -> Option<Rect> {
    match end {
        RoutingEnd::Point { point, .. } => Some(Rect { x: point.x, y: point.y, w: 0.0, h: 0.0 }),
        RoutingEnd::Node { node, .. } => nodes.iter().find(|n| n.id == *node).map(|n| n.rect),
    }
}

/// The node an end names, looked up as `nodeAtEnd` over a map built from
/// the node list: the LAST node with the id.
#[must_use]
pub fn node_at_end<'a>(nodes: &'a [RoutingNode], end: &RoutingEnd) -> Option<&'a RoutingNode> {
    let id = end.node()?;
    nodes.iter().rev().find(|n| n.id == id)
}

#[cfg(test)]
mod tests {
    use super::{RoutableEdge, RoutingEnd, RoutingNode, node_at_end, rect_at_end};
    use crate::geometry::{Point, Rect};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn node(id: u32, x: f64) -> RoutingNode {
        RoutingNode { id, rect: Rect { x, y: 0.0, w: 10.0, h: 10.0 } }
    }

    const fn on(node: u32) -> RoutingEnd {
        RoutingEnd::Node { node, side: None, arrowhead: None }
    }

    #[test]
    fn a_repeated_id_resolves_first_for_its_rect_and_last_for_its_node() {
        let nodes = [node(1, 0.0), node(1, 50.0)];
        assert_eq!(rect_at_end(&nodes, &on(1)).map(|r| r.x), Some(0.0));
        assert_eq!(node_at_end(&nodes, &on(1)).map(|n| n.rect.x), Some(50.0));
        assert_eq!(rect_at_end(&nodes, &on(2)), None);
    }

    #[test]
    fn two_free_ends_are_not_a_self_loop() {
        let free = RoutingEnd::Point { point: Point { x: 1.0, y: 2.0 }, arrowhead: None };
        let line = RoutableEdge { id: 0, from: free, to: free, bends: None };
        assert!(!line.is_self_loop());
        assert!(RoutableEdge { id: 0, from: on(3), to: on(3), bends: None }.is_self_loop());
        assert_eq!(rect_at_end(&[], &free).map(|r| (r.x, r.w)), Some((1.0, 0.0)));
    }
}
