//! Routing-budget answers that cargo-mutants showed no other test pinned.
//! Every expected value is what canvas-render's `routing-budget.ts` returns
//! for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::routing_budget::{RoutingBudget, SearchShare};

/// A search may spend its whole share in one take — the cap refuses only
/// work PAST it — and then has nothing left, not even one visit.
#[test]
fn a_share_covers_exactly_its_cap_and_then_refuses() {
    let mut budget = RoutingBudget::for_layout();
    let mut share = SearchShare::default();
    assert!(share.take(&mut budget, 20_000_000.0));
    assert!(!share.take(&mut budget, 1.0));
    assert_eq!(budget.trials.to_bits(), 180_000_000.0_f64.to_bits());
}
