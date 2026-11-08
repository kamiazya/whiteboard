//! Concrete answers of the straight style's detour helpers that
//! cargo-mutants showed no other test pinned. Every expected value is what
//! canvas-render's `straight-detour.ts` returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::straight_detour::{DetourObstacle, corner_detour, strict_interior};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// A leg lying ALONG a side of a block counts as running into it — the
/// block's own crossing test is closed there — so the quick bounding-box
/// rejection in front of it must not throw such a leg out.
#[test]
fn a_leg_along_any_side_of_a_block_is_blocked_and_goes_round() {
    let body = Rect { x: 10.0, y: 40.0, w: 20.0, h: 20.0 };
    let wall = [DetourObstacle { block: body, body, escapable: false }];
    let cases = [
        (p(10.0, 0.0), p(10.0, 100.0), p(2.0, 32.0)),
        (p(30.0, 0.0), p(30.0, 100.0), p(38.0, 32.0)),
        (p(-20.0, 40.0), p(60.0, 40.0), p(2.0, 32.0)),
        (p(-20.0, 60.0), p(60.0, 60.0), p(38.0, 68.0)),
    ];
    for (start, end, corner) in cases {
        assert_eq!(corner_detour(start, end, &wall, 8.0), Some(vec![start, corner, end]));
    }
}

/// The inset is the least of half a pixel and half of EACH dimension, and
/// both dimensions shrink by twice it.
#[test]
fn a_thin_rect_insets_by_half_its_width_and_an_ordinary_one_by_half_a_pixel() {
    assert_eq!(
        strict_interior(Rect { x: 1.0, y: 2.0, w: 0.4, h: 10.0 }),
        Rect { x: 1.2, y: 2.2, w: 0.0, h: 9.6 }
    );
    assert_eq!(
        strict_interior(Rect { x: 1.0, y: 2.0, w: 10.0, h: 10.0 }),
        Rect { x: 1.5, y: 2.5, w: 9.0, h: 9.0 }
    );
}

/// Boards as `[x, y, w, h, margin]` rows: the body, and a block grown from
/// it by the margin on every side. None is escapable.
fn board(rows: &[[f64; 5]]) -> Vec<DetourObstacle> {
    rows.iter()
        .map(|&[x, y, w, h, m]| DetourObstacle {
            block: Rect { x: x - m, y: y - m, w: w + 2.0 * m, h: h + 2.0 * m },
            body: Rect { x, y, w, h },
            escapable: false,
        })
        .collect()
}

fn path(points: &[(f64, f64)]) -> Vec<Point> {
    points.iter().map(|&(x, y)| p(x, y)).collect()
}

/// The search ranks open corners by distance so far PLUS the straight
/// distance still to go; ranking by the difference expands a corner far
/// from the end first, closes it on a longer path, and keeps that path.
#[test]
fn the_search_ranks_corners_by_distance_so_far_plus_distance_to_go() {
    let rows = [
        [130.0, 190.0, 20.0, 30.0, 0.0],
        [105.0, 273.0, 10.0, 20.0, 3.0],
        [190.0, 200.0, 20.0, 20.0, 0.0],
    ];
    assert_eq!(
        corner_detour(p(103.0, 300.0), p(290.0, 70.0), &board(&rows), 10.0),
        Some(path(&[(103.0, 300.0), (125.0, 303.0), (180.0, 190.0), (290.0, 70.0)]))
    );
}

/// Past 24 boxes in the way the search stops growing and answers the best
/// route found so far: on this board a round would take it to 25, so the
/// route is the one found through the boxes it had.
#[test]
fn past_twenty_four_blockers_the_search_keeps_the_route_it_has() {
    assert_eq!(
        corner_detour(p(311.0, 290.0), p(90.0, 10.0), &board(&CROWDED), 11.0),
        Some(path(&[(311.0, 290.0), (321.0, 245.0), (201.0, 181.0), (147.0, 37.0), (90.0, 10.0)]))
    );
}

/// Exactly 24 boxes in the way is still within the budget: the search runs
/// one more round, and the corners it adds change the route it answers.
#[test]
fn exactly_twenty_four_blockers_is_still_within_the_budget() {
    assert_eq!(
        corner_detour(p(-10.0, 32.0), p(308.0, 222.0), &board(&TWENTY_FOUR), 10.0),
        Some(path(&[(-10.0, 32.0), (30.0, 60.0), (180.0, 70.0), (220.0, 100.0), (308.0, 222.0)]))
    );
}

const CROWDED: [[f64; 5]; 25] = [
    [280.0, 256.0, 30.0, 4.0, 6.0],
    [140.0, 200.0, 10.0, 10.0, 0.0],
    [270.0, 110.0, 20.0, 20.0, 0.0],
    [280.0, 140.0, 20.0, 20.0, 0.0],
    [295.0, 190.0, 20.0, 20.0, 0.0],
    [170.0, 290.0, 10.0, 20.0, 0.0],
    [100.0, 110.0, 20.0, 20.0, 0.0],
    [190.0, 70.0, 10.0, 20.0, 7.0],
    [180.0, 110.0, 20.0, 10.0, 0.0],
    [90.0, 80.0, 10.0, 20.0, 0.0],
    [266.0, 278.0, 20.0, 16.0, 0.0],
    [170.0, 60.0, 20.0, 20.0, 0.0],
    [140.0, 230.0, 20.0, 10.0, 0.0],
    [250.0, 150.0, 10.0, 20.0, 0.0],
    [211.0, 298.0, 23.0, 10.0, 6.0],
    [174.0, 280.0, 20.0, 20.0, 0.0],
    [160.0, 260.0, 10.0, 10.0, 0.0],
    [80.0, 100.0, 20.0, 20.0, 0.0],
    [100.0, 100.0, 24.0, 30.0, 0.0],
    [230.0, 170.0, 20.0, 20.0, 0.0],
    [150.0, 120.0, 13.0, 20.0, 0.0],
    [170.0, 192.0, 20.0, 20.0, 0.0],
    [250.0, 260.0, 12.0, 10.0, 0.0],
    [180.0, 60.0, 10.0, 20.0, 7.0],
    [124.0, 48.0, 12.0, 23.0, 8.0],
];

const TWENTY_FOUR: [[f64; 5]; 24] = [
    [30.0, 45.0, 20.0, 10.0, 0.0],
    [170.0, 170.0, 10.0, 20.0, 7.0],
    [140.0, 80.0, 30.0, 15.0, 0.0],
    [110.0, 37.0, 10.0, 20.0, 0.0],
    [40.0, 140.0, 10.0, 4.0, 0.0],
    [90.0, 4.0, 10.0, 23.0, 2.0],
    [70.0, 90.0, 20.0, 16.0, 0.0],
    [70.0, 100.0, 20.0, 10.0, 0.0],
    [170.0, 80.0, 20.0, 10.0, 0.0],
    [190.0, 136.0, 4.0, 20.0, 0.0],
    [240.0, 160.0, 20.0, 20.0, 0.0],
    [60.0, 82.0, 20.0, 20.0, 0.0],
    [50.0, 130.0, 10.0, 10.0, 0.0],
    [100.0, 160.0, 10.0, 20.0, 0.0],
    [90.0, 90.0, 21.0, 25.0, 0.0],
    [200.0, 110.0, 10.0, 10.0, 0.0],
    [280.0, 150.0, 20.0, 20.0, 0.0],
    [150.0, 150.0, 10.0, 10.0, 0.0],
    [40.0, 40.0, 10.0, 10.0, 0.0],
    [250.0, 190.0, 10.0, 10.0, 0.0],
    [230.0, 140.0, 10.0, 10.0, 0.0],
    [50.0, 100.0, 20.0, 20.0, 0.0],
    [23.0, 76.0, 20.0, 21.0, 8.0],
    [190.0, 130.0, 10.0, 22.0, 8.0],
];
