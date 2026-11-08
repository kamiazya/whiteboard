//! Boards that pin the coincident-ends repair's choice, one per class of
//! mistake the whole-workspace suite let through: the arrow runway, the
//! tier/bends/length order of `better_repair`, the candidate ranking's centre
//! delta, the edge-index lookup, and which edges count as collided.
//!
//! Every expected anchor pair is what canvas-render's
//! `anchorsWithoutCoincidentEnds` answers for the same board.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::coincident_ends::{
    CoincidentRequest, anchors_without_coincident_ends,
};
use whiteboard_edge_routing::edge_geometry::Side::{self, Bottom, Left, Right, Top};
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};

/// One edge: id, from node and its named side, to node and its named side,
/// and the side pair the search handed the repair.
type EdgeSpec = (u32, u32, Option<Side>, u32, Option<Side>, (Side, Side));

/// What the repair left one edge with: its two sides and its two anchors.
type Answer = (Side, Side, (f64, f64), (f64, f64));

struct Board<'a> {
    rects: &'a [(f64, f64, f64, f64)],
    edges: &'a [EdgeSpec],
    style: RoutingStyle,
    align: bool,
}

fn repaired(board: &Board<'_>) -> Vec<Answer> {
    let nodes: Vec<RoutingNode> = (0..)
        .zip(board.rects)
        .map(|(id, &(x, y, w, h))| RoutingNode { id, rect: Rect { x, y, w, h } })
        .collect();
    let end = |node, side| RoutingEnd::Node { node, side, arrowhead: None };
    let edges: Vec<RoutableEdge> = board
        .edges
        .iter()
        .map(|&(id, a, fs, b, ts, _)| RoutableEdge {
            id,
            from: end(a, fs),
            to: end(b, ts),
            bends: None,
        })
        .collect();
    let sides: JsMap<_, _> = board
        .edges
        .iter()
        .map(|&(id, .., (from_side, to_side))| (id, SidePair { from_side, to_side, around: false }))
        .collect();
    let style = board.style;
    let style_of = move |_: &RoutableEdge| style;
    let request =
        CoincidentRequest { labels: &[], style_of: &style_of, align: board.align, pins: None };
    let mut budget = RoutingBudget::for_layout();
    let anchors = anchors_without_coincident_ends(&nodes, &edges, &sides, &request, &mut budget);
    edges
        .iter()
        .map(|e| {
            let a = anchors.get(&e.id).copied().unwrap_or_default();
            let xy = |p: Option<Point>| p.map_or((f64::NAN, f64::NAN), |p| (p.x, p.y));
            (a.from_side.unwrap_or(Top), a.to_side.unwrap_or(Top), xy(a.from), xy(a.to))
        })
        .collect()
}

/// A member beside its holder with three edges, one named at an end: the
/// unnamed and half-named edges are both collided (one named side is not
/// "authored"), and each takes its clean, short pair over the first ranked.
#[test]
fn a_half_named_edge_is_repaired_and_the_shortest_clean_pair_wins() {
    let expected = [
        (Bottom, Bottom, (66.666_666_666_666_66, 160.0), (-53.333_333_333_333_336, 100.0)),
        (Bottom, Left, (-26.666_666_666_666_67, 100.0), (0.0, 80.0)),
        (Top, Bottom, (-40.0, 40.0), (133.333_333_333_333_31, 160.0)),
    ];
    assert_eq!(repaired(&A), expected);
}

/// The holder and a box flush on its right: the repair ranks its candidates
/// by the centre delta, so a delta computed wrong ranks a different pair first.
#[test]
fn the_candidates_are_ranked_by_the_true_centre_delta() {
    let expected = [
        (Right, Bottom, (200.0, 80.0), (210.0, 100.0)),
        (Left, Top, (-200.0, 220.0), (210.0, 40.0)),
    ];
    assert_eq!(repaired(&B), expected);
}

/// Two boxes sharing a top-right corner of the holder, two collided edges:
/// the second edge is patched at ITS OWN index, and a lower tier, then fewer
/// bends, decide its pair.
#[test]
fn a_second_collided_edge_is_patched_at_its_own_index() {
    let expected =
        [(Top, Top, (160.0, 0.0), (160.0, 20.0)), (Bottom, Right, (100.0, 160.0), (200.0, 40.0))];
    assert_eq!(repaired(&C), expected);
}

/// A member flush with the holder's top, three collided edges: the arrow
/// runway is measured on the final segment, and a shorter route of the same
/// tier and bends wins.
#[test]
fn the_runway_and_then_the_length_decide_between_clean_routes() {
    let expected = [
        (Right, Right, (140.0, 10.0), (200.0, 80.0)),
        (Bottom, Bottom, (100.0, 160.0), (100.0, 20.0)),
        (Left, Left, (0.0, 80.0), (60.0, 10.0)),
    ];
    assert_eq!(repaired(&D), expected);
}

/// The repair keeps a LATER candidate whose tier is better than the first
/// one that parted the ends.
#[test]
fn a_later_candidate_on_a_better_tier_replaces_the_first() {
    let expected =
        [(Right, Bottom, (200.0, 80.0), (40.0, 0.0)), (Top, Top, (80.0, -40.0), (40.0, -20.0))];
    assert_eq!(repaired(&E), expected);
}

/// Left and right score alike here, so the candidate order decides, and that
/// order follows the sign of the centre delta.
#[test]
fn between_equal_repairs_the_first_ranked_is_kept() {
    assert_eq!(repaired(&F), [(Left, Top, (0.0, 80.0), (80.0, 160.0))]);
}

const A: Board<'static> = Board {
    rects: &[(0.0, 0.0, 200.0, 160.0), (-80.0, 40.0, 80.0, 60.0)],
    edges: &[
        (10, 0, None, 1, Some(Bottom), (Bottom, Bottom)),
        (11, 1, None, 0, Some(Left), (Right, Left)),
        (12, 1, None, 0, None, (Top, Bottom)),
    ],
    style: RoutingStyle::Curved,
    align: true,
};
const B: Board<'static> = Board {
    rects: &[
        (0.0, 0.0, 200.0, 160.0),
        (-80.0, 0.0, 80.0, 40.0),
        (200.0, 40.0, 20.0, 60.0),
        (-200.0, 200.0, 80.0, 40.0),
    ],
    edges: &[(10, 0, None, 2, None, (Right, Left)), (11, 3, None, 2, Some(Top), (Left, Top))],
    style: RoutingStyle::Orthogonal,
    align: true,
};
const C: Board<'static> = Board {
    rects: &[
        (0.0, 0.0, 200.0, 160.0),
        (120.0, 0.0, 80.0, 60.0),
        (120.0, 20.0, 80.0, 40.0),
        (-60.0, 60.0, 60.0, 40.0),
    ],
    edges: &[(10, 1, None, 2, None, (Bottom, Bottom)), (11, 0, None, 2, None, (Bottom, Right))],
    style: RoutingStyle::Straight,
    align: true,
};
const D: Board<'static> = Board {
    rects: &[(0.0, 0.0, 200.0, 160.0), (60.0, 0.0, 80.0, 20.0)],
    edges: &[
        (10, 1, None, 0, None, (Right, Right)),
        (11, 0, None, 1, Some(Bottom), (Bottom, Bottom)),
        (12, 0, None, 1, None, (Top, Top)),
    ],
    style: RoutingStyle::Orthogonal,
    align: false,
};
const E: Board<'static> = Board {
    rects: &[(0.0, 0.0, 200.0, 160.0), (0.0, -20.0, 80.0, 20.0), (40.0, -40.0, 80.0, 40.0)],
    edges: &[(10, 0, None, 1, None, (Right, Bottom)), (11, 2, None, 1, Some(Top), (Left, Top))],
    style: RoutingStyle::Straight,
    align: false,
};
const F: Board<'static> = Board {
    rects: &[(0.0, 0.0, 200.0, 160.0), (20.0, 160.0, 20.0, 20.0), (40.0, 160.0, 80.0, 60.0)],
    edges: &[(10, 0, None, 2, Some(Top), (Bottom, Top))],
    style: RoutingStyle::Curved,
    align: true,
};
