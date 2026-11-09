//! The grid router's answers that cargo-mutants showed no other test pinned.
//! Every expected value is what canvas-render's `routeOnGrid` returns for
//! the same input, `spent` being what it subtracts from `budget.grid`.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::grid_route::{GridRoute, route_on_grid};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

const fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

/// A run that only touches a border at +infinity traces nothing along it,
/// so the step there costs the infinite run and nothing else, and the goal
/// at infinity is never reached: an infinite cost is not an improvement on
/// an unvisited one.
#[test]
fn a_border_at_infinity_traces_nothing_and_the_goal_stays_unreached() {
    let route = route_on_grid(
        p(0.0, 0.0),
        p(f64::INFINITY, 0.0),
        &[rect(f64::INFINITY, 0.0, 10.0, 10.0)],
        16.0,
        f64::INFINITY,
    );
    assert_eq!(route, GridRoute { path: None, spent: 12.0 });
}

/// With no clearance the box's own edges are grid lines, so running along
/// one is charged its traced length: the route takes the free line 10px
/// above the box (320px) over either of its borders (300px plus 40 traced).
#[test]
fn a_traced_border_is_charged_and_the_free_line_wins() {
    let route = route_on_grid(
        p(0.0, 50.0),
        p(200.0, 50.0),
        &[rect(80.0, 0.0, 40.0, 100.0), rect(300.0, -30.0, 10.0, 20.0)],
        0.0,
        f64::INFINITY,
    );
    let path = vec![p(0.0, 50.0), p(0.0, -10.0), p(200.0, -10.0), p(200.0, 50.0)];
    assert_eq!(route, GridRoute { path: Some(path), spent: 111.0 });
}
