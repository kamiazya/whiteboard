//! The side-choice search's behaviours that the rest of the suite left
//! unpinned, each found by a cargo-mutants survivor in `spatial_edges.rs`:
//! how edges past the gate are cut into Morton-ordered regions, which
//! offenders a pass above the full size tries, and what a search cut short
//! by its budget keeps. The expected values are `spatial-edges.ts`'s.
//!
//! Most of them read the region cut through one probe: the two edges of
//! `edge-crossing-min.test.ts`'s first case, which cross unless they are
//! searched together, when orange (edge 1) moves to red's top and yellow's
//! right. In one region the probe is untangled; split across two, each half
//! keeps its initial sides. A board then decides whether the cut falls
//! between the probe's edges, so a key computed differently moves it.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::edge_sides::EdgeAnchorPair;
use whiteboard_edge_routing::geometry::Rect;
use whiteboard_edge_routing::js_map::JsMap;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{EdgeId, RoutableEdge, RoutingEnd, RoutingNode};
use whiteboard_edge_routing::spatial_edges::assign_edge_anchors;

type Board = (Vec<RoutingNode>, Vec<RoutableEdge>);

const fn node(id: u32, x: f64, y: f64, w: f64, h: f64) -> RoutingNode {
    RoutingNode { id, rect: Rect { x, y, w, h } }
}

const fn end(node: u32) -> RoutingEnd {
    RoutingEnd::Node { node, side: None, arrowhead: None }
}

const fn edge(id: u32, from: u32, to: u32) -> RoutableEdge {
    RoutableEdge { id, from: end(from), to: end(to), bends: None }
}

/// `assignEdgeAnchors(nodes, edges, style, undefined, budget)`.
fn anchors_with(
    (nodes, edges): (&[RoutingNode], &[RoutableEdge]),
    style: RoutingStyle,
    budget: RoutingBudget,
) -> JsMap<EdgeId, EdgeAnchorPair> {
    let styles = vec![style; edges.len()];
    let mut budget = budget;
    assign_edge_anchors((nodes, &[]), (edges, &styles), None, &mut budget)
}

fn sides(a: &JsMap<EdgeId, EdgeAnchorPair>, id: EdgeId) -> Option<(Side, Side)> {
    a.get(&id).and_then(|p| Some((p.from_side?, p.to_side?)))
}

/// The probe's three boxes with their top-left at `(px, py)`: red, yellow
/// and cyan as ids 1, 2 and 3.
fn probe_nodes((px, py): (f64, f64)) -> Vec<RoutingNode> {
    vec![
        node(1, px, py + 100.0, 300.0, 120.0),
        node(2, px + 450.0, py + 290.0, 260.0, 130.0),
        node(3, px + 630.0, py + 610.0, 280.0, 160.0),
    ]
}

/// An aligned pair of boxes 200 apart from `(x, y)`, ids `id` and `id + 1`,
/// and the edge `id` between them: nothing to repair on its own.
fn filler(board: &mut Board, id: u32, (x, y): (f64, f64)) {
    board.0.push(node(id, x, y, 100.0, 60.0));
    board.0.push(node(id + 1, x + 200.0, y, 100.0, 60.0));
    board.1.push(edge(id, id, id + 1));
}

/// 201 edges: the probe at `probe`, orange first and red last, and 199
/// fillers between them on a 20-wide grid from `fill`.
fn grid_board(probe: (f64, f64), fill: (f64, f64)) -> Board {
    let mut board = (probe_nodes(probe), vec![edge(1, 2, 1)]);
    for k in 0..199_u32 {
        let at = (fill.0 + f64::from(k % 20) * 400.0, fill.1 + f64::from(k / 20) * 300.0);
        filler(&mut board, 10 + 2 * k, at);
    }
    board.1.push(edge(2, 1, 3));
    board
}

/// 201 edges round a probe at 100000: orange first, 100 fillers below and
/// left of it from the origin, 98 above and right of it from 200000, the
/// trigger pair at `trigger`, then red. Regions are 101 and 100 edges, so
/// the probe's edges share one exactly when the trigger's Morton key sorts
/// before both of theirs.
fn trigger_board(trigger: (f64, f64)) -> Board {
    let mut board = (probe_nodes((100_000.0, 100_000.0)), vec![edge(1, 2, 1)]);
    for k in 0..100_u32 {
        let at = (f64::from(k % 20) * 400.0, f64::from(k / 20) * 300.0);
        filler(&mut board, 10 + 2 * k, at);
    }
    for k in 0..98_u32 {
        let at = (200_000.0 + f64::from(k % 10) * 400.0, 200_000.0 + f64::from(k / 10) * 300.0);
        filler(&mut board, 1000 + 2 * k, at);
    }
    filler(&mut board, 5000, trigger);
    board.1.push(edge(2, 1, 3));
    board
}

fn probe_sides((nodes, edges): &Board) -> [Option<(Side, Side)>; 2] {
    let a = anchors_with((nodes, edges), RoutingStyle::Orthogonal, RoutingBudget::for_layout());
    [sides(&a, 1), sides(&a, 2)]
}

const TOGETHER: [Option<(Side, Side)>; 2] =
    [Some((Side::Top, Side::Right)), Some((Side::Bottom, Side::Left))];
const SPLIT: [Option<(Side, Side)>; 2] =
    [Some((Side::Left, Side::Bottom)), Some((Side::Bottom, Side::Left))];

#[test]
fn regions_follow_the_morton_curve_not_document_order() {
    // The probe's edges are first and last in the document but nearest
    // the origin of every midpoint, so they lead the curve together.
    assert_eq!(probe_sides(&grid_board((0.0, 0.0), (2000.0, 2000.0))), TOGETHER);
}

#[test]
fn a_canvas_far_from_the_origin_is_measured_from_its_own_corner() {
    let board = grid_board((100_000.0, 100_000.0), (102_000.0, 102_000.0));
    assert_eq!(probe_sides(&board), TOGETHER);
}

#[test]
fn a_midpoint_off_the_end_of_an_axis_keys_zero() {
    // The trigger's boxes sit at y = 1.7e308: its midpoint's y overflows to
    // infinity while its x is finite, and either one makes the key zero.
    assert_eq!(probe_sides(&trigger_board((50_000.0, 1.7e308))), TOGETHER);
}

#[test]
fn a_midpoint_is_the_mean_of_the_centres_on_x() {
    // Level with orange's midpoint and far to its left: before it on the
    // curve by x, which is all that separates them.
    assert_eq!(probe_sides(&trigger_board((50_000.0, 100_227.5))), TOGETHER);
}

#[test]
fn a_trigger_left_of_and_below_the_probe_sorts_between_its_edges() {
    // Placed by scanning the TypeScript's key: between orange and red on
    // the curve, cut on 1023 cells per axis and with y's bits above x's.
    assert_eq!(probe_sides(&trigger_board((99_055.0, 100_662.0))), SPLIT);
}

#[test]
fn a_trigger_right_of_and_above_the_probe_sorts_before_both_its_edges() {
    assert_eq!(probe_sides(&trigger_board((101_589.0, 99_849.0))), TOGETHER);
}

#[test]
fn a_midpoint_halves_the_sum_rather_than_doubling_it() {
    // At 5e307 the trigger's centres sum to 1e308: halved, a finite key
    // that sorts last; doubled, an infinity that keys zero and sorts first.
    assert_eq!(probe_sides(&trigger_board((5e307, 50_000.0))), SPLIT);
    assert_eq!(probe_sides(&trigger_board((50_000.0, 5e307))), SPLIT);
}

#[test]
fn a_last_region_of_two_edges_is_searched() {
    // 39602 edges make 198 regions of 200 and one of 2: the probe, whose
    // midpoints sort past those of the dangling edges, which key at the
    // origin and have nothing to search.
    let mut edges: Vec<RoutableEdge> =
        (0..39_600_u32).map(|k| edge(100_000 + k, 99_998, 99_999)).collect();
    edges.extend([edge(1, 2, 1), edge(2, 1, 3)]);
    assert_eq!(probe_sides(&(probe_nodes((0.0, 0.0)), edges)), TOGETHER);
}

/// `stackedFramesBoard()` (routing-corpus.ts): ids 1 and 2 the frames,
/// 3..=8 the notes a1..a6, 9..=14 b1..b6; edges 1..=4 `a1_b6`, `a2_b5`, `a3_b1`
/// and `a5_b2`.
fn stacked_frames() -> Board {
    let mut nodes = vec![node(1, 0.0, 0.0, 640.0, 300.0), node(2, 0.0, 380.0, 640.0, 300.0)];
    let mut id = 3;
    for y in [40.0, 170.0, 420.0, 550.0] {
        for x in [40.0, 240.0, 440.0] {
            nodes.push(node(id, x, y, 160.0, 100.0));
            id += 1;
        }
    }
    let edges = vec![edge(1, 3, 14), edge(2, 4, 13), edge(3, 5, 9), edge(4, 7, 10)];
    (nodes, edges)
}

#[test]
fn a_seed_adopted_on_other_sides_survives_a_search_cut_short() {
    // edge-straight-detour.test.ts: the first run adopts a3_b1 stepping
    // round on other sides, then runs out before it has priced a1_b6, for
    // a trials account in [3154, 4294). The adopted one stays round.
    let (nodes, edges) = stacked_frames();
    let budget = RoutingBudget { trials: 3700.0, ..RoutingBudget::for_layout() };
    let a = anchors_with((&nodes, &edges), RoutingStyle::Straight, budget);
    let a3_b1 = a.get(&3).map(|p| (p.from_side, p.to_side, p.around));
    assert_eq!(a3_b1, Some((Some(Side::Left), Some(Side::Right), true)));
    assert_eq!(a.get(&1).map(|p| p.around), Some(false));
}

/// 40 probes in a row, 1200 apart; probe k is nodes `4k+1..` and edges
/// `3k+1..`. From the 21st on each carries a third edge from a box below
/// into yellow, a costlier tangle the search repairs by re-siding red.
fn probe_row() -> Board {
    let (mut nodes, mut edges) = (Vec::new(), Vec::new());
    for k in 0..40_u32 {
        let x = f64::from(k) * 1200.0;
        let (n, e) = (4 * k, 3 * k);
        nodes.extend(probe_nodes((x, 0.0)).into_iter().map(|p| RoutingNode { id: p.id + n, ..p }));
        edges.extend([edge(e + 1, n + 2, n + 1), edge(e + 2, n + 1, n + 3)]);
        if k >= 20 {
            nodes.push(node(n + 4, x + 350.0, 600.0, 100.0, 100.0));
            edges.push(edge(e + 3, n + 4, n + 2));
        }
    }
    (nodes, edges)
}

#[test]
fn a_pass_past_the_full_size_tries_the_worst_offenders_first() {
    // 100 edges, so a pass tries only 16. Ranked worst first, the heavy
    // probes at the end of the document are reached and every probe is
    // repaired; in document order the last of them never would be.
    let (nodes, edges) = probe_row();
    let a = anchors_with((&nodes, &edges), RoutingStyle::Orthogonal, RoutingBudget::for_layout());
    assert_eq!(sides(&a, 1), Some((Side::Top, Side::Right)));
    for k in [20, 39] {
        assert_eq!(sides(&a, 3 * k + 1), Some((Side::Left, Side::Bottom)));
        assert_eq!(sides(&a, 3 * k + 2), Some((Side::Right, Side::Top)));
    }
}
