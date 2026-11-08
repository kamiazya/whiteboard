//! The side search's incremental score on boards that reach what the
//! whole-workspace suite did not: the order a trial re-scores its pairs in,
//! which decides what a refused trial leaves of the `pairs` account, and the
//! broad phase's Int32 bounding boxes at the edge of the Int32 range, where
//! the TypeScript's `Int32Array` wraps `min - 1` and `max + 1`.
//!
//! The wrapping boards draw one free line `a` (edge 0) at a coordinate whose
//! quantum is an Int32 extreme, and one boxed edge (edge 1) that crosses it
//! and is re-sided, so the trial prices the pair through `pairScore`.

#![expect(clippy::float_cmp, reason = "every cost and account here is an exact integer")]

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::config_score::{ConfigScore, RouteCache, ScoreInputs};
use whiteboard_edge_routing::edge_geometry::Side::{self, Bottom, Left, Right, Top};
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::edge_rules::{Cost, SidePair};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};

/// The crossings tier of a [`Cost`].
const CROSSINGS: usize = 2;

const fn pair(from_side: Side, to_side: Side) -> SidePair {
    SidePair { from_side, to_side, around: false }
}

fn node_end(node: u32) -> RoutingEnd {
    RoutingEnd::Node { node, side: None, arrowhead: None }
}

/// `p` with x and y swapped when `t`: the same board turned on its diagonal.
const fn flip(t: bool, x: f64, y: f64) -> Point {
    if t { Point { x: y, y: x } } else { Point { x, y } }
}

const fn flip_rect(t: bool, r: Rect) -> Rect {
    if t { Rect { x: r.y, y: r.x, w: r.h, h: r.w } } else { r }
}

const fn flip_side(t: bool, s: Side) -> Side {
    match (t, s) {
        (false, s) => s,
        (true, Top) => Left,
        (true, Left) => Top,
        (true, Bottom) => Right,
        (true, Right) => Bottom,
    }
}

/// The cost of re-siding edge 1 (box `n` above the line to box `m`) from
/// its left side to its bottom, with edge 0 the free line `a` along y = 0.
fn re_sided_cost(a: [(f64, f64); 2], m: Rect, t: bool) -> Option<Cost> {
    let n = Rect { x: -20.0, y: -80.0, w: 40.0, h: 40.0 };
    let nodes = [
        RoutingNode { id: 0, rect: flip_rect(t, n) },
        RoutingNode { id: 1, rect: flip_rect(t, m) },
    ];
    let free = |(x, y): (f64, f64)| RoutingEnd::Point { point: flip(t, x, y), arrowhead: None };
    let edges = [
        RoutableEdge { id: 1, from: free(a[0]), to: free(a[1]), bends: None },
        RoutableEdge { id: 2, from: node_end(0), to: node_end(1), bends: None },
    ];
    let leaving = |s: Side| pair(flip_side(t, s), flip_side(t, Top));
    let sides: JsMap<_, _> = [(1, leaving(Top)), (2, leaving(Left))].into_iter().collect();
    let styles = [RoutingStyle::Straight; 2];
    let (mut cache, mut budget) = (RouteCache::new(), RoutingBudget::for_layout());
    let inputs = ScoreInputs {
        nodes: &nodes,
        labels: &[],
        edges: &edges,
        styles: &styles,
        align: false,
        pins: None,
    };
    let mut score = ConfigScore::new(inputs, &sides, &mut cache, &mut budget);
    let mut trial = sides.clone();
    trial.set(2, leaving(Bottom));
    score.evaluate_trial(&trial, 1, &mut cache, &mut budget).map(|t| t.cost)
}

/// Edge 1's far box just below the line, so its re-sided route is a short drop.
const NEAR: Rect = Rect { x: -20.0, y: 200.0, w: 40.0, h: 40.0 };

fn crossings(a: [(f64, f64); 2], m: Rect, t: bool) -> f64 {
    re_sided_cost(a, m, t).map_or(f64::NAN, |c| c[CROSSINGS])
}

/// A line starting at x = -2^29 starts at quantum -2^31, where `min - 1`
/// wraps to 2^31 - 1: the broad phase reads the bbox as far right of every
/// other and drops the pair, so the crossing goes unpriced. One quantum in,
/// nothing wraps and the same crossing is priced.
#[test]
fn a_bbox_min_that_wraps_drops_the_crossing() {
    for t in [false, true] {
        assert_eq!(crossings([(-536_870_912.0, 0.0), (1000.0, 0.0)], NEAR, t), 0.0);
        assert_eq!(crossings([(-536_870_911.75, 0.0), (1000.0, 0.0)], NEAR, t), 1.0);
    }
}

/// The mirror case: a line ending at quantum 2^31 - 1, where `max + 1`
/// wraps to -2^31.
#[test]
fn a_bbox_max_that_wraps_drops_the_crossing() {
    for t in [false, true] {
        assert_eq!(crossings([(-1000.0, 0.0), (536_870_911.75, 0.0)], NEAR, t), 0.0);
        assert_eq!(crossings([(-1000.0, 0.0), (536_870_911.5, 0.0)], NEAR, t), 1.0);
    }
}

/// A wrapped bound EQUAL to the other path's bound is not "beyond" it: the
/// broad phase drops a pair only on a strict `>`. Edge 1's long diagonal
/// ends at quantum 2^31 - 2, so its `max + 1` equals the line's wrapped
/// `min - 1`, and the crossing is priced.
#[test]
fn a_wrapped_min_equal_to_the_other_max_still_prices_the_crossing() {
    let far_right = Rect { x: 536_870_891.5, y: 100_000_000.0, w: 40.0, h: 40.0 };
    for t in [false, true] {
        assert_eq!(crossings([(-536_870_912.0, 0.0), (1000.0, 0.0)], far_right, t), 1.0);
    }
}

/// The mirror: the diagonal starts at quantum -2^31 + 1, so its `min - 1`
/// equals the line's wrapped `max + 1`.
#[test]
fn a_wrapped_max_equal_to_the_other_min_still_prices_the_crossing() {
    let far_left = Rect { x: -536_870_931.75, y: 100_000_000.0, w: 40.0, h: 40.0 };
    for t in [false, true] {
        assert_eq!(crossings([(-1000.0, 0.0), (536_870_911.75, 0.0)], far_left, t), 1.0);
    }
}

/// A board where re-siding edge 0 touches several edges, priced with ten
/// segment pairs left. A pair of two touched edges is scored from the
/// LOWER index, so the trial asks first for a pair the account cannot
/// cover and is refused having spent nothing — leaving the next trial,
/// which needs all ten, room to be priced.
#[test]
fn a_refused_trial_leaves_the_pairs_account_it_did_not_reach() {
    let rect = |x, y, w, h| Rect { x, y, w, h };
    let nodes: Vec<RoutingNode> = [
        rect(240.0, 180.0, 30.0, 40.0),
        rect(300.0, 180.0, 20.0, 40.0),
        rect(240.0, 60.0, 30.0, 40.0),
        rect(0.0, 120.0, 30.0, 20.0),
    ]
    .into_iter()
    .zip(0..)
    .map(|(rect, id)| RoutingNode { id, rect })
    .collect();
    let ends = [(1, 0), (3, 0), (2, 0), (3, 2)];
    let edges: Vec<RoutableEdge> = (10..)
        .zip(ends)
        .map(|(id, (a, b))| RoutableEdge { id, from: node_end(a), to: node_end(b), bends: None })
        .collect();
    let initial = [pair(Left, Bottom), pair(Left, Bottom), pair(Left, Top), pair(Right, Right)];
    let sides: JsMap<_, _> = (10..).zip(initial).collect();
    let styles = [
        RoutingStyle::Curved,
        RoutingStyle::Curved,
        RoutingStyle::Straight,
        RoutingStyle::Straight,
    ];
    let (mut cache, mut budget) = (RouteCache::new(), RoutingBudget::for_layout());
    let inputs = ScoreInputs {
        nodes: &nodes,
        labels: &[],
        edges: &edges,
        styles: &styles,
        align: true,
        pins: None,
    };
    let mut score = ConfigScore::new(inputs, &sides, &mut cache, &mut budget);
    budget.pairs = 10.0;
    let mut first = sides.clone();
    first.set(10, pair(Left, Left));
    assert!(score.evaluate_trial(&first, 0, &mut cache, &mut budget).is_none());
    assert_eq!(budget.pairs, 10.0);
    let mut second = sides.clone();
    second.set(11, pair(Bottom, Top));
    let priced = score.evaluate_trial(&second, 1, &mut cache, &mut budget).map(|t| t.cost);
    assert_eq!(priced, Some([122.0, 0.0, 1.0, 0.0, 0.0, 3.0, 7.0]));
    assert_eq!(budget.pairs, 0.0);
}
