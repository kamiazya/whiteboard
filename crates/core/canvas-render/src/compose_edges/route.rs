//! The edge pass's one call into the router: a canvas's nodes and routable
//! elements as `whiteboard-edge-routing` reads them, routed on one layout's
//! budget, and the answer given back its string ids.
//!
//! Ids are interned as `core-wasm`'s `encodeLayout` interns them, the one
//! encoding the router is held to: node ids in canvas order and then each end
//! as it is read, so an end naming no node gets an id no node holds; element ids
//! in their own table, so a repeated id is one id.

use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_router::{RoutedEdge, RoutingStyle};
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::layout_routes::route_layout;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{Arrowhead, RoutableEdge, RoutingEnd, RoutingNode};
use whiteboard_model::spatial::{
    Arrowhead as ModelArrowhead, CanvasPoint, EdgeEnd, EdgeSide, LineEnd, SpatialNode,
};
use whiteboard_scene::BoundingBox;

use crate::theme::appearance::RoutableElement;

#[derive(Default)]
struct Interner<'a> {
    ids: Vec<&'a str>,
}

impl<'a> Interner<'a> {
    fn of(&mut self, id: &'a str) -> u32 {
        let at = self.ids.iter().position(|known| *known == id).unwrap_or_else(|| {
            self.ids.push(id);
            self.ids.len().saturating_sub(1)
        });
        u32::try_from(at).unwrap_or(u32::MAX)
    }

    fn name(&self, id: u32) -> Option<&'a str> {
        usize::try_from(id).ok().and_then(|at| self.ids.get(at).copied())
    }
}

pub(super) const fn routing_side(side: EdgeSide) -> Side {
    match side {
        EdgeSide::Top => Side::Top,
        EdgeSide::Right => Side::Right,
        EdgeSide::Bottom => Side::Bottom,
        EdgeSide::Left => Side::Left,
    }
}

pub(super) const fn model_side(side: Side) -> EdgeSide {
    match side {
        Side::Top => EdgeSide::Top,
        Side::Right => EdgeSide::Right,
        Side::Bottom => EdgeSide::Bottom,
        Side::Left => EdgeSide::Left,
    }
}

const fn arrowhead(end: Option<ModelArrowhead>) -> Option<Arrowhead> {
    match end {
        Some(ModelArrowhead::Arrow) => Some(Arrowhead::Arrow),
        Some(ModelArrowhead::None) => Some(Arrowhead::None),
        None => None,
    }
}

const fn point(p: &CanvasPoint) -> Point {
    Point { x: p.x, y: p.y }
}

fn node_end<'a>(
    node: &'a str,
    side: Option<EdgeSide>,
    end: Option<ModelArrowhead>,
    nodes: &mut Interner<'a>,
) -> RoutingEnd {
    RoutingEnd::Node {
        node: nodes.of(node),
        side: side.map(routing_side),
        arrowhead: arrowhead(end),
    }
}

fn ends<'a>(element: RoutableElement<'a>, nodes: &mut Interner<'a>) -> [RoutingEnd; 2] {
    let edge_end =
        |end: &'a EdgeEnd, nodes: &mut Interner<'a>| node_end(&end.node, end.side, end.end, nodes);
    let line_end = |end: &'a LineEnd, nodes: &mut Interner<'a>| match end {
        LineEnd::LineEndNode(on) => node_end(&on.node, on.side, on.end, nodes),
        LineEnd::LineEndPoint(at) => {
            RoutingEnd::Point { point: point(&at.point), arrowhead: arrowhead(at.end) }
        }
    };
    match element {
        RoutableElement::Edge(edge) => [edge_end(&edge.from, nodes), edge_end(&edge.to, nodes)],
        RoutableElement::Line(line) => [line_end(&line.from, nodes), line_end(&line.to, nodes)],
    }
}

pub(super) const fn element_id(element: RoutableElement<'_>) -> &str {
    match element {
        RoutableElement::Edge(edge) => edge.id.as_str(),
        RoutableElement::Line(line) => line.id.as_str(),
    }
}

fn bends(element: RoutableElement<'_>) -> Option<Vec<Point>> {
    let stored = match element {
        RoutableElement::Edge(edge) => edge.bends.as_ref(),
        RoutableElement::Line(line) => line.bends.as_ref(),
    };
    stored.map(|points| points.iter().map(point).collect())
}

/// What the router is handed beside the canvas.
pub(super) struct RouteInput<'a> {
    pub elements: &'a [RoutableElement<'a>],
    pub styles: Vec<RoutingStyle>,
    pub titles: &'a [BoundingBox],
    /// The editor's frozen sides by element id; present, even empty, keeps the
    /// live drag's hard gate on the search.
    pub overrides: Option<&'a [(String, EdgeAnchorOverride)]>,
}

/// Every element routed, in order, and the anchors the search settled, by id.
pub(super) fn route(
    nodes: &[SpatialNode],
    input: &RouteInput<'_>,
) -> (Vec<RoutedEdge>, Vec<(String, EdgeAnchorPair)>) {
    let mut node_ids = Interner::default();
    let mut edge_ids = Interner::default();
    let routing_nodes: Vec<RoutingNode> = nodes
        .iter()
        .map(|n| RoutingNode {
            id: node_ids.of(&n.id),
            rect: Rect { x: n.x, y: n.y, w: n.width, h: n.height },
        })
        .collect();
    let edges: Vec<RoutableEdge> = input
        .elements
        .iter()
        .map(|&element| {
            let id = edge_ids.of(element_id(element));
            let [from, to] = ends(element, &mut node_ids);
            RoutableEdge { id, from, to, bends: bends(element) }
        })
        .collect();
    // An override naming no element is skipped by the search; the router has no id for it.
    let overrides = input.overrides.map(|pins| {
        let mut known = JsMap::default();
        for (id, pin) in pins {
            if let Some(at) = edge_ids.ids.iter().position(|seen| seen == id) {
                known.set(u32::try_from(at).unwrap_or(u32::MAX), *pin);
            }
        }
        known
    });
    let labels: Vec<Rect> =
        input.titles.iter().map(|b| Rect { x: b.x, y: b.y, w: b.w, h: b.h }).collect();
    let mut budget = RoutingBudget::for_layout();
    let (anchors, routes) = route_layout(
        (&routing_nodes, &labels),
        (&edges, &input.styles),
        overrides.as_ref(),
        &mut budget,
    );
    let named = anchors
        .iter()
        .filter_map(|(id, pair)| edge_ids.name(*id).map(|name| (name.to_owned(), *pair)))
        .collect();
    (routes, named)
}
