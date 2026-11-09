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
/// an unvisited one. The allowance is finite so that a mutated search that
/// never settles fails here rather than running on.
#[test]
fn a_border_at_infinity_traces_nothing_and_the_goal_stays_unreached() {
    let route = route_on_grid(
        p(0.0, 0.0),
        p(f64::INFINITY, 0.0),
        &[rect(f64::INFINITY, 0.0, 10.0, 10.0)],
        16.0,
        1000.0,
    );
    assert_eq!(route, GridRoute { path: None, spent: 12.0 });
}

/// With no clearance the box's own edges are grid lines, so running along
/// one is charged its traced length: the route takes the free line 10px
/// above the box (320px) over either of its borders (300px plus 40 traced).
/// The allowance is finite, and well above the 111 tests the route spends,
/// so a search that mis-charges a border fails here instead of running on.
#[test]
fn a_traced_border_is_charged_and_the_free_line_wins() {
    let route = route_on_grid(
        p(0.0, 50.0),
        p(200.0, 50.0),
        &[rect(80.0, 0.0, 40.0, 100.0), rect(300.0, -30.0, 10.0, 20.0)],
        0.0,
        10_000.0,
    );
    let path = vec![p(0.0, 50.0), p(0.0, -10.0), p(200.0, -10.0), p(200.0, 50.0)];
    assert_eq!(route, GridRoute { path: Some(path), spent: 111.0 });
}

/// 31 one-pixel boxes on a diagonal give 64 x lines and 64 y lines: exactly
/// the 4096-cell cap, which is still searched (only a grid past it is not).
#[test]
fn a_grid_of_exactly_the_cell_cap_is_still_searched() {
    let boxes: Vec<Rect> = (0..31)
        .map(|k| {
            let at = 10.0 + 30.0 * f64::from(k);
            rect(at, at, 1.0, 1.0)
        })
        .collect();
    let route = route_on_grid(p(0.0, 0.0), p(1000.0, 1000.0), &boxes, 0.0, 20_000.0);
    let path = vec![p(0.0, 0.0), p(1000.0, 0.0), p(1000.0, 1000.0)];
    assert_eq!(route, GridRoute { path: Some(path), spent: 10739.0 });
}

/// Two walls reaching past the search window put an obstacle on every grid
/// line, so every step is charged and a finite allowance bounds any search
/// that does not settle. The next two tests stand between them.
const WALLS: [Rect; 2] = [rect(200.0, -1000.0, 100.0, 2000.0), rect(-1000.0, 100.0, 2000.0, 100.0)];

/// The walls make the bucketing cost 20 tests, and an allowance of exactly
/// 20 still starts the search: only one BELOW it is refused before anything
/// is spent. The first expansion's tests then overdraw it, so the call
/// answers no route having spent 22.
#[test]
fn an_allowance_equal_to_the_bucketing_still_starts_the_search() {
    let route = route_on_grid(p(0.0, 0.0), p(100.0, 0.0), &WALLS, 0.0, 20.0);
    assert_eq!(route, GridRoute { path: None, spent: 22.0 });
}

/// Between the walls the straight run is unblocked and costs 24 tests.
#[test]
fn a_straight_run_between_two_walls_settles_within_its_allowance() {
    let route = route_on_grid(p(0.0, 0.0), p(100.0, 0.0), &WALLS, 0.0, 1000.0);
    assert_eq!(route, GridRoute { path: Some(vec![p(0.0, 0.0), p(100.0, 0.0)]), spent: 24.0 });
}

/// Walls on three sides of a box: the detour over its top border settles well
/// inside the allowance, at 141 tests.
#[test]
fn a_detour_between_walls_settles_within_its_allowance() {
    let obstacles = [
        rect(80.0, 0.0, 40.0, 100.0),
        rect(300.0, -1000.0, 100.0, 2000.0),
        rect(-1000.0, 150.0, 2000.0, 100.0),
        rect(-1000.0, -300.0, 2000.0, 100.0),
    ];
    let route = route_on_grid(p(0.0, 50.0), p(200.0, 50.0), &obstacles, 0.0, 100_000.0);
    let path = vec![p(0.0, 50.0), p(0.0, 0.0), p(200.0, 0.0), p(200.0, 50.0)];
    assert_eq!(route, GridRoute { path: Some(path), spent: 141.0 });
}
