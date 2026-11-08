//! The sweep-and-prune broad phase is EXACTLY the full pairwise scan: the
//! optimizer's lexicographic cost comparisons are integer-exact, so one missed
//! candidate pair changes side-choice equilibria. The O(E^2) double loop over
//! the shared narrow phase is the oracle, and the shared-corner count is taken
//! here by set intersection rather than by the sweep's bucket walk.
//!
//! The TypeScript twin is `edge-crossing-sweep.properties.test.ts`.

// The scores are integer-quantized sums, so the sweep owes the scan exact
// equality, as the TypeScript's toEqual asks of it.
#![expect(clippy::float_cmp, reason = "integer-quantized scores are compared exactly")]

use std::collections::{BTreeMap, BTreeSet};

use whiteboard_edge_routing::edge_crossing_sweep::{
    PairScore, build_pairwise_scores, score_segment_pair,
};
use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::layout_routes::route_layout;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, TestCaseError, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// `Math.round`, which rounds a half towards positive infinity.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

#[expect(clippy::cast_possible_truncation, reason = "a quantized test coordinate is small")]
fn corners(path: &[Point]) -> BTreeSet<(i64, i64)> {
    let interior = path.get(1..path.len().saturating_sub(1)).unwrap_or(&[]);
    interior.iter().map(|p| (js_round(p.x * 4.0) as i64, js_round(p.y * 4.0) as i64)).collect()
}

/// The O(E^2) oracle: every pair, zero scores included.
fn oracle(paths: &[Vec<Point>]) -> BTreeMap<usize, PairScore> {
    let mut scores = BTreeMap::new();
    for i in 0..paths.len() {
        for j in i + 1..paths.len() {
            let mut sum = [0.0; 3];
            for a in paths[i].windows(2) {
                for b in paths[j].windows(2) {
                    let s = score_segment_pair(a[0], a[1], b[0], b[1]);
                    for k in 0..3 {
                        sum[k] += s[k];
                    }
                }
            }
            let shared = corners(&paths[i]).intersection(&corners(&paths[j])).count();
            sum[2] += f64::from(u32::try_from(shared).unwrap_or(0));
            scores.insert(i * paths.len() + j, sum);
        }
    }
    scores
}

/// The sweep's matrix against the oracle, both ways: no pair missed, and no
/// pair the oracle scored zero invented.
fn agrees(paths: &[Vec<Point>], density: &[Floor; 2]) -> Result<(), TestCaseError> {
    let expected = oracle(paths);
    let actual: BTreeMap<usize, PairScore> = build_pairwise_scores(paths, None)
        .map(|m| m.iter().map(|(k, v)| (*k, *v)).collect())
        .unwrap_or_default();
    for (key, exp) in &expected {
        prop_assert_eq!(actual.get(key).copied().unwrap_or([0.0; 3]), *exp, "pair {}", key);
        density[0].draw(exp[0] > 0.0);
        density[1].draw(exp[2] > 0.0);
    }
    for (key, got) in &actual {
        prop_assert_eq!(*got, expected.get(key).copied().unwrap_or([0.0; 3]), "pair {}", key);
    }
    Ok(())
}

/// Raw grid-snapped polylines, denser in the sweep's degenerate cases than
/// anything the router emits: collinear corridors, shared endpoints, vertical
/// stacks, zero-length segments, and sub-quantum jitter the bbox slack exists
/// for (`round(4n)` rates a 0.24px jitter equal to its grid neighbour).
fn raw_paths() -> impl Strategy<Value = Vec<Vec<Point>>> {
    let jitter = prop_oneof![Just(0.0), Just(0.0), Just(0.1), Just(0.24)];
    let coordinate = (0u32..=4, jitter).prop_map(|(n, j)| f64::from(n) * 5.0 + j);
    let point = (coordinate.clone(), coordinate).prop_map(|(x, y)| Point { x, y });
    prop::collection::vec(prop::collection::vec(point, 2..=5), 2..=10)
}

#[test]
fn raw_grid_polylines_agree_with_the_pairwise_scan() {
    let density = [Floor::new("an overlapping pair"), Floor::new("a crossing pair")];
    check(raw_paths(), None, |paths| agrees(&paths, &density));
    // Counted per pair, about 3500 a run: measured 50 to 54 overlapping and
    // 2049 to 2100 crossing (the TypeScript, 41 overlapping).
    density[0].assert(25);
    density[1].assert(1000);
}

/// Few nodes on a small field, so edges share sides and cross.
fn routed_paths() -> impl Strategy<Value = Vec<Vec<Point>>> {
    let step = |lo: u32, hi: u32| (lo..=hi).prop_map(|n| f64::from(n) * 10.0);
    let boxes = prop::collection::vec((step(0, 60), step(0, 60), step(6, 20), step(5, 12)), 8);
    let pairs = prop::collection::vec((0u32..=7, 0u32..=7), 2..=24);
    let style = prop_oneof![
        Just(RoutingStyle::Straight),
        Just(RoutingStyle::Orthogonal),
        Just(RoutingStyle::Curved)
    ];
    (3u32..=8, boxes, pairs, style).prop_map(|(count, boxes, pairs, style)| {
        let nodes: Vec<RoutingNode> = (0..count)
            .zip(&boxes)
            .map(|(id, &(x, y, w, h))| RoutingNode { id, rect: Rect { x, y, w, h } })
            .collect();
        let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        let edges: Vec<RoutableEdge> = (0u32..)
            .zip(pairs)
            .map(|(id, (from, to))| RoutableEdge {
                id,
                from: end(from % count),
                to: end(to % count),
                bends: None,
            })
            .filter(|e| e.from.node() != e.to.node())
            .collect();
        let styles = vec![style; edges.len()];
        let (_, routed) =
            route_layout((&nodes, &[]), (&edges, &styles), None, &mut RoutingBudget::for_layout());
        routed.into_iter().map(|r| r.path).collect()
    })
}

#[test]
fn routed_paths_agree_with_the_pairwise_scan() {
    let density = [Floor::new("an overlapping pair"), Floor::new("a crossing pair")];
    check(routed_paths(), Some(120), |paths| agrees(&paths, &density));
    // Crossings are what the routed domain answers for (measured 388 to 569
    // crossing pairs a run); overlaps it reaches rarely (38 to 44 of about
    // 7000 pairs), which the raw domain covers at full strength.
    density[1].assert(150);
}

#[test]
fn a_budget_covering_the_sweep_changes_nothing_and_one_pair_less_refuses_it() {
    let refused = Floor::new("a sweep that examined something");
    check(raw_paths(), None, |paths| {
        let mut measured = RoutingBudget { grid: 0.0, pairs: 1e9, trials: 0.0, repairs: 0.0 };
        let _ = build_pairwise_scores(&paths, Some(&mut measured));
        let spend = 1e9 - measured.pairs;
        let mut exact = RoutingBudget { pairs: spend, ..measured };
        prop_assert_eq!(
            build_pairwise_scores(&paths, Some(&mut exact)),
            build_pairwise_scores(&paths, None)
        );
        prop_assert_eq!(exact.pairs, 0.0);
        refused.draw(spend > 0.0);
        if spend > 0.0 {
            let mut short = RoutingBudget { pairs: spend - 1.0, ..measured };
            prop_assert!(build_pairwise_scores(&paths, Some(&mut short)).is_none());
            // What it examined before refusing is spent: the account goes negative.
            prop_assert!(short.pairs < 0.0);
        }
        Ok(())
    });
    // Measured 198 to 199 of 200.
    refused.assert(150);
}
