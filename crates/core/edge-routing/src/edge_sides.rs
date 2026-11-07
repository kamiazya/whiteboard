//! Which side an edge leaves from and arrives at, and the first guess the
//! side-choice search starts from: canvas-render's `layout/edges/edge-sides.ts`,
//! ported function for function. The reasoning is written once, in the
//! TypeScript.
//!
//! Maps keyed by edge id are [`JsMap`]s, so a repeated id keeps its first
//! position and its last value, as `Map.prototype.set` does. Nodes are read
//! through [`node_at_end`], the last node with an id, as the TypeScript's
//! `byId` map holds.

use crate::edge_geometry::{Side, center_of, side_point, strictly_inside};
use crate::edge_rules::{
    End, PreferenceContext, SidePair, compose_side_pairs, fully_contains, opposite_side,
};
use crate::geometry::{Point, Rect};
use crate::js_map::JsMap;
use crate::routing_input::{EdgeId, NodeId, RoutableEdge, RoutingNode, node_at_end};

type FacingSides = [Side; 4];

/// The four sides ranked by how squarely they face `(dx, dy)`.
fn facing_sides(dx: f64, dy: f64) -> FacingSides {
    let h = if dx >= 0.0 { Side::Right } else { Side::Left };
    let v = if dy >= 0.0 { Side::Bottom } else { Side::Top };
    if dx.abs() >= dy.abs() {
        [h, v, opposite_side(v), opposite_side(h)]
    } else {
        [v, h, opposite_side(h), opposite_side(v)]
    }
}

/// The edge's default sides between two placed boxes, as
/// `deriveDefaultSides`: the ranked pair's first, each end moved to the next
/// facing side when a bystander covers its midpoint.
#[must_use]
pub fn derive_default_sides(
    nodes: &[RoutingNode],
    edge: &RoutableEdge,
    from_rect: Rect,
    to_rect: Rect,
    crowd: &dyn Fn(End, Side) -> f64,
) -> SidePair {
    let (from_center, to_center) = (center_of(from_rect), center_of(to_rect));
    let dx = to_center.x - from_center.x;
    let dy = to_center.y - from_center.y;
    let pairs = compose_side_pairs(&PreferenceContext { dx, dy, from_rect, to_rect, crowd });
    let (from_id, to_id) = (edge.from.node(), edge.to.node());
    let foreign: Vec<Rect> = nodes
        .iter()
        .filter(|n| Some(n.id) != from_id && Some(n.id) != to_id)
        .map(|n| n.rect)
        .collect();
    let exposed = |rect: Rect, side: Side| {
        !foreign
            .iter()
            .filter(|&&r| !fully_contains(r, rect))
            .any(|&r| strictly_inside(r, side_point(rect, side)))
    };
    // composeSidePairs always ranks at least the two opposing pairs.
    let best = pairs.first().copied().unwrap_or(SidePair {
        from_side: Side::Right,
        to_side: Side::Left,
        around: false,
    });
    let pick = |rect: Rect, primary: Side, mirror: FacingSides| {
        std::iter::once(primary)
            .chain(mirror.into_iter().filter(|&s| s != primary))
            .find(|&s| exposed(rect, s))
            .unwrap_or(primary)
    };
    let from_mirror = facing_sides(dx, dy);
    let to_mirror = from_mirror.map(opposite_side);
    let from_side = pick(from_rect, best.from_side, from_mirror);
    let h = if dx >= 0.0 { Side::Right } else { Side::Left };
    let v = if dy >= 0.0 { Side::Bottom } else { Side::Top };
    let horizontal = matches!(from_side, Side::Left | Side::Right);
    let partner = if from_side == best.from_side {
        best.to_side
    } else {
        opposite_side(if horizontal { v } else { h })
    };
    SidePair { from_side, to_side: pick(to_rect, partner, to_mirror), around: false }
}

const SELF_EDGE_LOOP_OFFSET_PX: f64 = 40.0;
const SELF_EDGE_LOOP_SPREAD_PX: f64 = 20.0;

/// The two control points of a self-loop leaving `start` on `side`.
#[must_use]
pub fn self_edge_loop_control_points(start: Point, side: Side) -> [Point; 2] {
    let (o, s) = (SELF_EDGE_LOOP_OFFSET_PX, SELF_EDGE_LOOP_SPREAD_PX);
    match side {
        Side::Right => {
            [Point { x: start.x + o, y: start.y - s }, Point { x: start.x + o, y: start.y + s }]
        }
        Side::Left => {
            [Point { x: start.x - o, y: start.y - s }, Point { x: start.x - o, y: start.y + s }]
        }
        Side::Top => {
            [Point { x: start.x - s, y: start.y - o }, Point { x: start.x + s, y: start.y - o }]
        }
        Side::Bottom => {
            [Point { x: start.x - s, y: start.y + o }, Point { x: start.x + s, y: start.y + o }]
        }
    }
}

/// What the anchor pass hands the router for one edge, as `EdgeAnchorPair`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct EdgeAnchorPair {
    pub from: Option<Point>,
    pub to: Option<Point>,
    pub from_lane_depth: Option<f64>,
    pub to_lane_depth: Option<f64>,
    pub from_side: Option<Side>,
    pub to_side: Option<Side>,
    pub around: bool,
}

/// A frozen side choice and anchors for one edge, as `EdgeAnchorOverride`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeAnchorOverride {
    pub sides: SidePair,
    pub from: Option<Point>,
    pub from_lane_depth: Option<f64>,
    pub to: Option<Point>,
    pub to_lane_depth: Option<f64>,
}

/// Each edge's prospective sides and how many prospective ends each
/// (node, side) carries, as `prospectiveSideCrowding`.
fn prospective_side_crowding(
    edges: &[RoutableEdge],
    nodes: &[RoutingNode],
) -> (JsMap<(NodeId, Side), f64>, JsMap<EdgeId, SidePair>) {
    let mut crowd_counts: JsMap<(NodeId, Side), f64> = JsMap::default();
    let mut prospective: JsMap<EdgeId, SidePair> = JsMap::default();
    for edge in edges {
        let (Some(from_node), Some(to_node)) =
            (node_at_end(nodes, &edge.from), node_at_end(nodes, &edge.to))
        else {
            continue;
        };
        if edge.is_self_loop() {
            continue;
        }
        let (fc, tc) = (center_of(from_node.rect), center_of(to_node.rect));
        let [primary, ..] = facing_sides(tc.x - fc.x, tc.y - fc.y);
        let sides = SidePair {
            from_side: edge.from.side().unwrap_or(primary),
            to_side: edge.to.side().unwrap_or_else(|| opposite_side(primary)),
            around: false,
        };
        prospective.set(edge.id, sides);
        for key in [(from_node.id, sides.from_side), (to_node.id, sides.to_side)] {
            let count = crowd_counts.get(&key).copied().unwrap_or(0.0);
            crowd_counts.set(key, count + 1.0);
        }
    }
    (crowd_counts, prospective)
}

/// The side-choice search's starting point, as `initialSideChoices`: a
/// named side kept, the rest derived against the prospective crowding.
#[must_use]
pub fn initial_side_choices(
    nodes: &[RoutingNode],
    edges: &[RoutableEdge],
) -> JsMap<EdgeId, SidePair> {
    let (crowd_counts, prospective) = prospective_side_crowding(edges, nodes);
    let mut choices: JsMap<EdgeId, SidePair> = JsMap::default();
    for edge in edges {
        let (Some(from_node), Some(to_node)) =
            (node_at_end(nodes, &edge.from), node_at_end(nodes, &edge.to))
        else {
            continue;
        };
        let own = prospective.get(&edge.id).copied();
        let crowd = |end: End, side: Side| {
            let (node_id, own_side) = match end {
                End::From => (from_node.id, own.map(|o| o.from_side)),
                End::To => (to_node.id, own.map(|o| o.to_side)),
            };
            let count = crowd_counts.get(&(node_id, side)).copied().unwrap_or(0.0);
            if own_side == Some(side) { count - 1.0 } else { count }
        };
        let derived = if edge.is_self_loop() {
            SidePair { from_side: Side::Right, to_side: Side::Right, around: false }
        } else {
            derive_default_sides(nodes, edge, from_node.rect, to_node.rect, &crowd)
        };
        choices.set(
            edge.id,
            SidePair {
                from_side: edge.from.side().unwrap_or(derived.from_side),
                to_side: edge.to.side().unwrap_or(derived.to_side),
                around: false,
            },
        );
    }
    choices
}

/// As `ORTHOGONAL_STUB_PX`.
pub const ORTHOGONAL_STUB_PX: f64 = 20.0;

/// As `STUB_LANE_STEP_PX`.
pub const STUB_LANE_STEP_PX: f64 = 12.0;

#[cfg(test)]
mod tests {
    use super::{initial_side_choices, self_edge_loop_control_points};
    use crate::edge_geometry::Side;
    use crate::geometry::{Point, Rect};
    use crate::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn node(id: u32, x: f64, y: f64) -> RoutingNode {
        RoutingNode { id, rect: Rect { x, y, w: 100.0, h: 60.0 } }
    }

    const fn on(node: u32, side: Option<Side>) -> RoutingEnd {
        RoutingEnd::Node { node, side, arrowhead: None }
    }

    #[test]
    fn side_by_side_boxes_start_facing_and_a_named_side_is_kept() {
        let nodes = [node(1, 0.0, 0.0), node(2, 300.0, 0.0)];
        let edges = [
            RoutableEdge { id: 7, from: on(1, None), to: on(2, None), bends: None },
            RoutableEdge { id: 8, from: on(1, Some(Side::Top)), to: on(2, None), bends: None },
        ];
        let choices = initial_side_choices(&nodes, &edges);
        let first = choices.get(&7).map(|p| (p.from_side, p.to_side));
        assert_eq!(first, Some((Side::Right, Side::Left)));
        assert_eq!(choices.get(&8).map(|p| p.from_side), Some(Side::Top));
        let [a, b] = self_edge_loop_control_points(Point { x: 0.0, y: 0.0 }, Side::Top);
        assert_eq!((a, b), (Point { x: -20.0, y: -40.0 }, Point { x: 20.0, y: -40.0 }));
    }
}
