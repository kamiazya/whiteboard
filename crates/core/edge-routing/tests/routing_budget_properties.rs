//! The routing budget may only ever REFUSE work; it must never change an
//! answer it could afford. Route a board with an account too large to refuse
//! anything, read back what it spent, and route it again with an account
//! holding exactly that much: every check refuses only work the account cannot
//! cover, so the second layout must equal the first, and so must a layout
//! under the default account, which these boards never exhaust.
//!
//! The TypeScript twin is `routing-budget.properties.test.ts`; here the layout
//! is [`route_layout`], the one call the composer makes.

use whiteboard_edge_routing::edge_router::RoutingStyle;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::layout_routes::route_layout;
use whiteboard_edge_routing::routing_budget::RoutingBudget;
use whiteboard_edge_routing::routing_input::{RoutableEdge, RoutingEnd, RoutingNode};
use whiteboard_proptest::proptest::prelude::{Just, Strategy, prop, prop_assert_eq, prop_oneof};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const AMPLE: f64 = 1e12;

#[derive(Debug)]
struct Board {
    nodes: Vec<RoutingNode>,
    edges: Vec<RoutableEdge>,
    style: RoutingStyle,
}

/// Crowded boxes, so the enumerated candidates fail and the grid router runs,
/// and edges that sometimes carry bends, so the search scores segment pairs of
/// paths it did not route.
fn board() -> impl Strategy<Value = Board> {
    let step = |lo: u32, hi: u32, by: f64| (lo..=hi).prop_map(move |n| f64::from(n) * by);
    let boxes = prop::collection::vec(
        (step(0, 40, 15.0), step(0, 40, 15.0), step(4, 14, 15.0), step(3, 10, 15.0)),
        4..=12,
    );
    let bends = prop_oneof![
        Just(Vec::new()),
        prop::collection::vec(
            (step(0, 60, 10.0), step(0, 60, 10.0)).prop_map(|(x, y)| Point { x, y }),
            1..=6
        ),
    ];
    let links = prop::collection::vec((0u32..=11, 0u32..=11, bends), 1..=16);
    let style = prop_oneof![
        Just(RoutingStyle::Orthogonal),
        Just(RoutingStyle::Orthogonal),
        Just(RoutingStyle::Curved),
        Just(RoutingStyle::Straight),
    ];
    (boxes, links, style).prop_map(|(boxes, links, style)| {
        let nodes: Vec<RoutingNode> = (0u32..)
            .zip(&boxes)
            .map(|(id, &(x, y, w, h))| RoutingNode { id, rect: Rect { x, y, w, h } })
            .collect();
        let count = u32::try_from(nodes.len()).unwrap_or(1);
        let end = |node| RoutingEnd::Node { node, side: None, arrowhead: None };
        let edges = (0u32..)
            .zip(links)
            .map(|(id, (from, to, bends))| RoutableEdge {
                id,
                from: end(from % count),
                to: end(to % count),
                bends: (!bends.is_empty()).then_some(bends),
            })
            .filter(|e| e.from.node() != e.to.node())
            .collect();
        Board { nodes, edges, style }
    })
}

fn ample() -> RoutingBudget {
    RoutingBudget { grid: AMPLE, pairs: AMPLE, trials: AMPLE, repairs: AMPLE }
}

#[test]
fn an_account_holding_exactly_what_a_layout_spends_lays_it_out_unchanged() {
    let floors = [
        Floor::new("a board the grid router spends on"),
        Floor::new("a board the pair scoring spends on"),
    ];
    check(board(), Some(80), |b| {
        let styles = vec![b.style; b.edges.len()];
        let lay = |budget: &mut RoutingBudget| {
            route_layout((&b.nodes, &[]), (&b.edges, &styles), None, budget)
        };
        let mut measured = ample();
        let first = lay(&mut measured);
        let spent = RoutingBudget {
            grid: AMPLE - measured.grid,
            pairs: AMPLE - measured.pairs,
            trials: AMPLE - measured.trials,
            repairs: AMPLE - measured.repairs,
        };
        let mut exact = spent;
        prop_assert_eq!(&lay(&mut exact), &first);
        prop_assert_eq!(exact, RoutingBudget { grid: 0.0, pairs: 0.0, trials: 0.0, repairs: 0.0 });
        prop_assert_eq!(&lay(&mut RoutingBudget::for_layout()), &first);
        floors[0].draw(spent.grid > 0.0);
        floors[1].draw(spent.pairs > 0.0);
        Ok(())
    });
    // Measured 44 to 51 and 75 to 80 of 80 (the TypeScript, 38 and 73).
    floors[0].assert(25);
    floors[1].assert(50);
}
