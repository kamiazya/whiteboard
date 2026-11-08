//! Preventive properties over `route_edge`, `assign_edge_anchors` and the
//! rounded-edge flattening, each pinning an invariant whose violation shipped
//! (or nearly shipped) as a real defect, generalized from its example test so
//! the generator explores the arrangements nobody thought to write down.
//!
//! The TypeScript twin is `edge-routing.properties.test.ts`; a group node is a
//! plain box here, since the edge layer reads nothing of a node but its box.

// The TypeScript compares coordinates with toBe and toEqual, exactly.
#![expect(clippy::float_cmp, reason = "the TypeScript twin compares coordinates exactly")]

use std::collections::BTreeSet;

use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rounding::flatten_rounded_edge_path;
use whiteboard_edge_routing::edge_router::{RouteRequest, RoutedEdge, RoutingStyle, route_edge};
use whiteboard_edge_routing::edge_sides::EdgeAnchorPair;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{EdgeId, RoutableEdge, RoutingEnd, RoutingNode};
use whiteboard_edge_routing::spatial_edges::assign_edge_anchors;
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, TestCaseError, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

type Box4 = (i32, i32, i32, i32);

fn node(id: u32, (x, y, w, h): Box4) -> RoutingNode {
    RoutingNode {
        id,
        rect: Rect { x: f64::from(x), y: f64::from(y), w: f64::from(w), h: f64::from(h) },
    }
}

const fn end(node: u32, side: Option<Side>) -> RoutingEnd {
    RoutingEnd::Node { node, side, arrowhead: None }
}

const fn edge(id: u32, from: RoutingEnd, to: RoutingEnd) -> RoutableEdge {
    RoutableEdge { id, from, to, bends: None }
}

fn route(nodes: &[RoutingNode], e: &RoutableEdge, style: RoutingStyle) -> RoutedEdge {
    route_edge(nodes, e, style, RouteRequest::default())
}

fn route_at(
    nodes: &[RoutingNode],
    e: &RoutableEdge,
    style: RoutingStyle,
    anchors: Option<&EdgeAnchorPair>,
) -> RoutedEdge {
    route_edge(nodes, e, style, RouteRequest { anchors, ..RouteRequest::default() })
}

/// `assignEdgeAnchors(nodes, edges, style)` with the default budget.
fn anchors_for(
    nodes: &[RoutingNode],
    edges: &[RoutableEdge],
    style: RoutingStyle,
) -> JsMap<EdgeId, EdgeAnchorPair> {
    let styles = vec![style; edges.len()];
    let mut budget = RoutingBudget::for_layout();
    assign_edge_anchors((nodes, &[]), (edges, &styles), None, &mut budget)
}

fn at(path: &[Point], i: usize) -> Result<Point, TestCaseError> {
    path.get(i).copied().ok_or_else(|| TestCaseError::fail(format!("no point {i} in {path:?}")))
}

fn last(path: &[Point]) -> Result<Point, TestCaseError> {
    path.last().copied().ok_or_else(|| TestCaseError::fail("an empty path"))
}

// ---- containers ------------------------------------------------------------

/// A rect strictly inside a W x H frame at the origin, with margin >= 1
/// (`x + w < W` is the TypeScript's `x + w <= W - 1` on integers).
fn inside_rect(w: i32, h: i32) -> impl Strategy<Value = Box4> {
    (1..=w - 60, 1..=h - 40, 20i32..=50, 20i32..=30)
        .prop_filter("inside the frame", move |&(x, y, rw, rh)| x + rw < w && y + rh < h)
}

fn member_arrangement() -> impl Strategy<Value = (i32, i32, Box4, Box4)> {
    (200i32..=600, 150i32..=400)
        .prop_flat_map(|(w, h)| (Just(w), Just(h), inside_rect(w, h), inside_rect(w, h)))
}

/// The container is not an obstacle for its members' edges: the route between
/// two members of an empty group is EXACTLY the route with the frame removed.
#[test]
fn an_empty_group_frame_never_changes_its_members_route() {
    check(member_arrangement(), None, |(w, h, a, b)| {
        let with_frame = [node(0, (0, 0, w, h)), node(1, a), node(2, b)];
        let without_frame = [node(1, a), node(2, b)];
        let e = edge(0, end(1, None), end(2, None));
        prop_assert_eq!(
            route(&with_frame, &e, RoutingStyle::Straight).path,
            route(&without_frame, &e, RoutingStyle::Straight).path
        );
        Ok(())
    });
}

// ---- orthogonal family -----------------------------------------------------

fn rect() -> impl Strategy<Value = Box4> {
    (-400i32..=400, -400i32..=400, 20i32..=200, 20i32..=200)
}

fn obstacle_board() -> impl Strategy<Value = (Vec<RoutingNode>, RoutableEdge)> {
    (rect(), rect(), prop::collection::vec(rect(), 0..=4)).prop_map(|(from, to, middles)| {
        let mut nodes = vec![node(0, from), node(1, to)];
        nodes.extend((2u32..).zip(middles).map(|(id, m)| node(id, m)));
        (nodes, edge(0, end(0, None), end(1, None)))
    })
}

#[test]
fn orthogonal_routes_are_axis_aligned_whatever_stands_in_the_way() {
    check(obstacle_board(), None, |(nodes, e)| {
        let path = route(&nodes, &e, RoutingStyle::Orthogonal).path;
        let aligned = path.windows(2).all(|w| matches!(w, [p, q] if p.x == q.x || p.y == q.y));
        prop_assert!(aligned, "{path:?}");
        Ok(())
    });
}

/// 'curved' differs from 'orthogonal' only in asking for rounded corners.
#[test]
fn curved_travels_exactly_the_orthogonal_waypoints() {
    check(obstacle_board(), None, |(nodes, e)| {
        prop_assert_eq!(
            route(&nodes, &e, RoutingStyle::Curved).path,
            route(&nodes, &e, RoutingStyle::Orthogonal).path
        );
        Ok(())
    });
}

// ---- rounded-edge flattening -----------------------------------------------

/// The drawn curve never leaves the waypoint polyline's bounds, the guarantee
/// that lets bounds, translate and scale keep working on the waypoints alone.
#[test]
fn flattening_preserves_endpoints_and_stays_inside_the_waypoint_bounds() {
    let point = (-1000i32..=1000, -1000i32..=1000)
        .prop_map(|(x, y)| Point { x: f64::from(x), y: f64::from(y) });
    check(prop::collection::vec(point, 2..=8), None, |path| {
        let flat = flatten_rounded_edge_path(&path);
        prop_assert_eq!(flat.first(), path.first());
        prop_assert_eq!(flat.last(), path.last());
        let fold = |f: fn(f64, f64) -> f64, of: fn(&Point) -> f64, from: f64| {
            path.iter().map(of).fold(from, f)
        };
        let (min_x, max_x) =
            (fold(f64::min, |p| p.x, f64::INFINITY), fold(f64::max, |p| p.x, -f64::INFINITY));
        let (min_y, max_y) =
            (fold(f64::min, |p| p.y, f64::INFINITY), fold(f64::max, |p| p.y, -f64::INFINITY));
        for p in &flat {
            prop_assert!(p.x >= min_x && p.x <= max_x && p.y >= min_y && p.y <= max_y, "{p:?}");
        }
        Ok(())
    });
}

// ---- anchor fan-out --------------------------------------------------------

#[derive(Debug)]
struct Hub {
    spokes: Vec<u32>,
    positions: Vec<(i32, i32)>,
    outward: Vec<bool>,
    pinned: Vec<Option<Side>>,
}

/// A HUB topology: every edge touches node 0, so shared (node, side) groups
/// are the common case rather than a lucky draw.
fn hub_scenario() -> impl Strategy<Value = Hub> {
    let spokes = prop::sample::subsequence(vec![1u32, 2, 3, 4, 5], 2..=5).prop_shuffle();
    let xy = (
        prop::sample::select(vec![-200, 300, 300, 300, -200]),
        prop::sample::select(vec![-150, 0, 150, 300, 450]),
    );
    let pin = prop_oneof![Just(None), Just(Some(Side::Top)), Just(Some(Side::Right))];
    let fives = (
        prop::collection::vec(xy, 5),
        prop::collection::vec(prop::bool::ANY, 5),
        prop::collection::vec(pin, 5),
    );
    (spokes, fives).prop_map(|(spokes, (positions, outward, pinned))| Hub {
        spokes,
        positions,
        outward,
        pinned,
    })
}

fn hub_board(h: &Hub) -> (Vec<RoutingNode>, Vec<RoutableEdge>) {
    let mut nodes = vec![node(0, (0, 0, 100, 100))];
    nodes
        .extend(h.spokes.iter().zip(&h.positions).map(|(&id, &(x, y))| node(id, (x, y, 100, 100))));
    let edges = (0u32..)
        .zip(&h.spokes)
        .zip(h.outward.iter().zip(&h.pinned))
        .map(|((i, &id), (&out, &pin))| {
            // The pinned side belongs to whichever end is the hub's.
            if out {
                edge(i, end(0, pin), end(id, None))
            } else {
                edge(i, end(id, None), end(0, pin))
            }
        })
        .collect();
    (nodes, edges)
}

/// The hub-side endpoint of every edge, with the side the route reports for it.
fn hub_ends(
    edges: &[RoutableEdge],
    routed: &[RoutedEdge],
) -> Result<Vec<(Side, Point)>, TestCaseError> {
    edges
        .iter()
        .zip(routed)
        .map(|(e, r)| {
            if e.from.node() == Some(0) {
                Ok((r.from_side, at(&r.path, 0)?))
            } else {
                Ok((r.to_side, last(&r.path)?))
            }
        })
        .collect()
}

fn on_hub_side(side: Side, p: Point) -> bool {
    let on_line = match side {
        Side::Left => p.x == 0.0,
        Side::Right => p.x == 100.0,
        Side::Top => p.y == 0.0,
        Side::Bottom => p.y == 100.0,
    };
    on_line && (0.0..=100.0).contains(&p.x) && (0.0..=100.0).contains(&p.y)
}

#[test]
fn ends_sharing_a_node_side_never_share_a_point_and_always_sit_on_their_side() {
    let shared = Floor::new("a hub side shared by two or more ends");
    check(hub_scenario(), None, |h| {
        let (nodes, edges) = hub_board(&h);
        let anchors = anchors_for(&nodes, &edges, RoutingStyle::Straight);
        let routed: Vec<RoutedEdge> = edges
            .iter()
            .map(|e| route_at(&nodes, e, RoutingStyle::Straight, anchors.get(&e.id)))
            .collect();
        let ends = hub_ends(&edges, &routed)?;
        let mut crowded = false;
        for side in [Side::Top, Side::Right, Side::Bottom, Side::Left] {
            let points: Vec<Point> = ends.iter().filter(|(s, _)| *s == side).map(|e| e.1).collect();
            for &p in &points {
                prop_assert!(on_hub_side(side, p), "{p:?} is not on the hub's {side:?}");
            }
            let keys: BTreeSet<(u64, u64)> =
                points.iter().map(|p| (p.x.to_bits(), p.y.to_bits())).collect();
            prop_assert_eq!(keys.len(), points.len(), "two ends on {:?} share a point", side);
            crowded |= points.len() >= 2;
        }
        shared.draw(crowded);
        Ok(())
    });
    // Measured 152 to 161 of 200.
    shared.assert(76);
}

// ---- occlusion-aware sides -------------------------------------------------

/// Whether two boxes touch — a shared stretch of border, or overlapping
/// bodies — without one holding the other. Such a pair is drawn as its
/// contact mark, which starts inside the source rather than on a side. Written
/// from the definition, not from `edge_contact`.
fn touches(a: Rect, b: Rect) -> bool {
    let ox = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let oy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    ox >= 0.0 && oy >= 0.0 && (ox > 0.0 || oy > 0.0) && !holds(a, b) && !holds(b, a)
}

fn holds(o: Rect, i: Rect) -> bool {
    i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h
}

fn mid_of(r: Rect, side: Side) -> Point {
    match side {
        Side::Top => Point { x: r.x + r.w / 2.0, y: r.y },
        Side::Bottom => Point { x: r.x + r.w / 2.0, y: r.y + r.h },
        Side::Left => Point { x: r.x, y: r.y + r.h / 2.0 },
        Side::Right => Point { x: r.x + r.w, y: r.y + r.h / 2.0 },
    }
}

fn strictly_in(r: Rect, p: Point) -> bool {
    p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
}

#[derive(Debug)]
struct Packed {
    nodes: Vec<RoutingNode>,
    from: usize,
    to: usize,
}

/// Chunky boxes on a tight grid, so an occluded default anchor is the common
/// case; the far column and row let the two ends sit apart.
fn packed_scenario() -> impl Strategy<Value = Packed> {
    let pick = |v: Vec<i32>| prop::sample::select(v);
    let r = (
        pick(vec![0, 40, 80, 120, 160, 320, 360]),
        pick(vec![0, 40, 80, 120, 280]),
        pick(vec![60, 100, 140]),
        pick(vec![60, 100, 140]),
    );
    (prop::collection::vec(r, 3..=6), 0usize..=5, 0usize..=5).prop_map(|(rects, f, t)| Packed {
        from: f % rects.len(),
        to: t % rects.len(),
        nodes: (0u32..).zip(rects).map(|(id, r)| node(id, r)).collect(),
    })
}

/// Whether the side the route took is occluded while some other is not; also
/// reports whether ANY side was occluded, for the floor.
fn occlusion_of(nodes: &[RoutingNode], ends: (u32, u32), this: Rect, side: Side) -> (bool, bool) {
    let occluders: Vec<Rect> = nodes
        .iter()
        .filter(|n| n.id != ends.0 && n.id != ends.1 && !holds(n.rect, this))
        .map(|n| n.rect)
        .collect();
    let occluded = |s: Side| occluders.iter().any(|&o| strictly_in(o, mid_of(this, s)));
    let all = [Side::Top, Side::Right, Side::Bottom, Side::Left];
    let violated = !all.iter().all(|&s| occluded(s)) && occluded(side);
    (violated, all.iter().any(|&s| occluded(s)))
}

#[test]
fn a_derived_side_anchor_is_never_strictly_inside_a_foreign_node_unless_every_side_is() {
    let sided = Floor::new("a pair apart enough to be sided");
    let occluded = Floor::new("an end with an occluded side");
    check(packed_scenario(), None, |p| {
        let (from, to) = (p.nodes.get(p.from).copied(), p.nodes.get(p.to).copied());
        let (Some(from), Some(to)) = (from, to) else { return Ok(()) };
        let apart = from.id != to.id && !touches(from.rect, to.rect);
        sided.draw(apart);
        if !apart {
            return Ok(());
        }
        let routed =
            route(&p.nodes, &edge(0, end(from.id, None), end(to.id, None)), RoutingStyle::Straight);
        for (this, side) in [(from.rect, routed.from_side), (to.rect, routed.to_side)] {
            let (violated, any) = occlusion_of(&p.nodes, (from.id, to.id), this, side);
            occluded.draw(any);
            prop_assert!(!violated, "{side:?} of {this:?} is occluded while another side is not");
        }
        Ok(())
    });
    // Measured 108 to 119 of 200 sided, and 64 to 77 of 216 to 238 sided ends
    // occluded (the TypeScript, 120 to 137 and 69 to 85).
    sided.assert(54);
    occluded.assert(32);
}

// ---- zero-bend alignment ---------------------------------------------------

/// Vertically stacked pairs whose x-spans always overlap (both hold 200..300),
/// with a vertical offset dominating every horizontal one: nothing is in the
/// way, so the orthogonal route is one straight segment.
#[test]
fn a_facing_vertical_pair_with_overlapping_spans_routes_as_one_straight_segment() {
    let pair = (0i32..=200, 120i32..=400, 0i32..=200, 120i32..=400, 250i32..=500);
    check(pair, None, |(ax, aw, bx, bw, gap)| {
        let a = node(0, (ax, 0, aw.max(300 - ax + 20), 100));
        let b = node(1, (bx, 100 + gap, bw.max(300 - bx + 20), 100));
        let path =
            route(&[a, b], &edge(0, end(0, None), end(1, None)), RoutingStyle::Orthogonal).path;
        prop_assert_eq!(path.len(), 2, "{:?}", path);
        prop_assert_eq!(at(&path, 0)?.x, at(&path, 1)?.x);
        Ok(())
    });
}

// ---- stub lanes ------------------------------------------------------------

/// The hub at the origin and `spokes` far to its right, every edge leaving the
/// hub's authored right side.
fn spoke_board(spokes: &[(i32, i32)]) -> (Vec<RoutingNode>, Vec<RoutableEdge>) {
    let mut nodes = vec![node(0, (0, 0, 100, 100))];
    nodes.extend((1u32..).zip(spokes).map(|(id, &(x, y))| node(id, (x, y, 100, 100))));
    let edges = (1u32..)
        .zip(spokes)
        .map(|(id, _)| edge(id, end(0, Some(Side::Right)), end(id, None)))
        .collect();
    (nodes, edges)
}

fn spoke_routes(spokes: &[(i32, i32)]) -> Vec<RoutedEdge> {
    let (nodes, edges) = spoke_board(spokes);
    let anchors = anchors_for(&nodes, &edges, RoutingStyle::Straight);
    edges
        .iter()
        .map(|e| route_at(&nodes, e, RoutingStyle::Orthogonal, anchors.get(&e.id)))
        .collect()
}

/// Each member of the hub's right group exits through its own corridor: the
/// full lane ladder, base 120 and step 12, not merely distinct stubs.
#[test]
fn every_member_of_a_shared_side_exits_through_a_distinct_corridor_outside_its_node() {
    let scenario = (1usize..=12, prop::collection::vec(0i32..=40, 12));
    check(scenario, None, |(count, jitters)| {
        let spokes: Vec<(i32, i32)> = (0i32..)
            .zip(jitters.iter().take(count))
            .map(|(i, &j)| (2000, 150 + i * 130 + j))
            .collect();
        let mut exits = spoke_routes(&spokes)
            .iter()
            .map(|r| at(&r.path, 1).map(|p| p.x))
            .collect::<Result<Vec<f64>, _>>()?;
        exits.sort_by(f64::total_cmp);
        let ladder: Vec<f64> = (0u32..).take(count).map(|i| 120.0 + f64::from(i) * 12.0).collect();
        prop_assert_eq!(exits, ladder);
        Ok(())
    });
}

/// Whether segment a1-a2 properly crosses segment b1-b2.
fn crosses(a1: Point, a2: Point, b1: Point, b2: Point) -> bool {
    let d = |p: Point, q: Point, r: Point| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    d(b1, b2, a1) * d(b1, b2, a2) < 0.0 && d(a1, a2, b1) * d(a1, a2, b2) < 0.0
}

/// Spokes both above and below the hub's right side, so the group mixes
/// upward- and downward-sweeping corridors. They stand CLOSE to the hub:
/// placed far out (x = 2000), every route ran its first elbow horizontally to
/// the target's stub, no lane run passed the node, and the property held
/// under the very defect it names (lane depth by list index), in the
/// TypeScript as well.
#[test]
fn no_lane_run_crosses_another_member_exit_at_the_node_for_mixed_sweep_directions() {
    let beside = Floor::new("a board with a lane run beside the hub");
    let scenario = (1i32..=5, 1i32..=5, 150i32..=300, prop::collection::vec(0i32..=40, 10));
    check(scenario, None, |(below, above, spoke_x, jitters)| {
        let jit = |i: i32| jitters.get(usize::try_from(i).unwrap_or(0)).copied().unwrap_or(0);
        let spokes: Vec<(i32, i32)> = (0..below)
            .map(|i| (spoke_x, 250 + i * 130 + jit(i)))
            .chain((0..above).map(|i| (spoke_x, -250 - i * 130 - jit(5 + i))))
            .collect();
        let routed = spoke_routes(&spokes);
        beside.draw(routed.iter().any(|r| lane_run_beside(&r.path, f64::from(spoke_x))));
        for (i, a) in routed.iter().enumerate() {
            for (j, b) in routed.iter().enumerate() {
                if i == j || a.path.len() < 3 || b.path.len() < 2 {
                    continue;
                }
                let (a1, a2, b1, b2) =
                    (at(&a.path, 1)?, at(&a.path, 2)?, at(&b.path, 0)?, at(&b.path, 1)?);
                prop_assert!(!crosses(a1, a2, b1, b2), "lane {i} crosses exit {j}");
            }
        }
        Ok(())
    });
    // Measured 112 to 121 of 200; 0 with the spokes at x = 2000.
    beside.assert(50);
}

/// Whether a route's run from its stub is vertical and short of the spokes:
/// the lane the property is about.
fn lane_run_beside(path: &[Point], spoke_x: f64) -> bool {
    matches!((path.get(1), path.get(2)), (Some(a), Some(b)) if a.x == b.x && a.x < spoke_x)
}

// ---- crossing minimization -------------------------------------------------

/// Dense chunky boxes with edges across them: crossings and degenerate
/// coincident stacks are the common case.
fn clutter_scenario() -> impl Strategy<Value = (Vec<RoutingNode>, Vec<RoutableEdge>)> {
    let pick = |v: Vec<i32>| prop::sample::select(v);
    let r = (
        pick(vec![0, 120, 240, 360, 480]),
        pick(vec![0, 120, 240, 360]),
        pick(vec![80, 140]),
        pick(vec![80, 140]),
    );
    let pairs = prop::collection::vec((0u32..=5, 0u32..=5), 3..=6);
    (prop::collection::vec(r, 4..=6), pairs).prop_map(|(rects, pairs)| {
        let count = u32::try_from(rects.len()).unwrap_or(1);
        let nodes = (0u32..).zip(rects).map(|(id, r)| node(id, r)).collect();
        let edges = (0u32..)
            .zip(pairs)
            .map(|(id, (f, t))| edge(id, end(f % count, None), end(t % count, None)))
            .filter(|e| e.from.node() != e.to.node())
            .collect();
        (nodes, edges)
    })
}

fn on_side(r: Rect, side: Side, p: Point) -> bool {
    let along_y = p.y >= r.y && p.y <= r.y + r.h;
    let along_x = p.x >= r.x && p.x <= r.x + r.w;
    match side {
        Side::Left => p.x == r.x && along_y,
        Side::Right => p.x == r.x + r.w && along_y,
        Side::Top => p.y == r.y && along_x,
        Side::Bottom => p.y == r.y + r.h && along_x,
    }
}

fn rect_of(nodes: &[RoutingNode], end: &RoutingEnd) -> Result<Rect, TestCaseError> {
    let id = end.node();
    nodes
        .iter()
        .find(|n| Some(n.id) == id)
        .map(|n| n.rect)
        .ok_or_else(|| TestCaseError::fail("a dangling end"))
}

/// The optimizer stays a pure deterministic function of the canvas, never
/// panics, and never detaches an anchor from its reported side.
#[test]
fn optimizing_stays_deterministic_total_and_keeps_every_anchor_on_its_reported_side() {
    check(clutter_scenario(), Some(60), |(nodes, edges)| {
        if edges.len() < 2 {
            return Ok(());
        }
        let a = anchors_for(&nodes, &edges, RoutingStyle::Orthogonal);
        prop_assert_eq!(&a, &anchors_for(&nodes, &edges, RoutingStyle::Orthogonal));
        for e in &edges {
            let routed = route_at(&nodes, e, RoutingStyle::Orthogonal, a.get(&e.id));
            let (from, to) = (rect_of(&nodes, &e.from)?, rect_of(&nodes, &e.to)?);
            if !touches(from, to) {
                prop_assert!(on_side(from, routed.from_side, at(&routed.path, 0)?), "{routed:?}");
            }
            prop_assert!(on_side(to, routed.to_side, last(&routed.path)?), "{routed:?}");
        }
        Ok(())
    });
}
