//! Where `edge_label_placement` puts a label on a board too exact for the
//! recorded boards to reach: obstacles that touch the label, sit one sliver
//! past the slide's reach, or sit where the run along a short line ends. Each
//! expected point is what the TypeScript's `edgeLabelPlacement` answered for
//! the same input.

use whiteboard_canvas_render::compose_edges::{LabelSize, edge_label_placement};
use whiteboard_scene::{BoundingBox, ScenePoint};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const fn at(x: f64, y: f64) -> ScenePoint {
    ScenePoint { x, y }
}

const fn rect(x: f64, y: f64, w: f64, h: f64) -> BoundingBox {
    BoundingBox { x, y, w, h }
}

fn placed(path: &[ScenePoint], w: f64, h: f64, obstacles: &[BoundingBox]) -> Option<ScenePoint> {
    edge_label_placement(path, LabelSize { w, h }, obstacles, false)
}

/// A box that only touches the label's box does not cover it, on any side.
#[test]
fn a_box_touching_the_label_leaves_it_at_the_midpoint() {
    let flat = [at(0.0, 0.0), at(200.0, 0.0)];
    for touching in [
        rect(70.0, -5.0, 20.0, 10.0),
        rect(110.0, -5.0, 20.0, 10.0),
        rect(90.0, -15.0, 20.0, 10.0),
        rect(90.0, 5.0, 20.0, 10.0),
    ] {
        assert_eq!(placed(&flat, 20.0, 10.0, &[touching]), Some(at(100.0, 0.0)), "{touching:?}");
    }
}

/// A core covering every spot within 120px of the midpoint, and one sliver at
/// the outer edge of each spot 128px out: every spot is covered, so the label
/// stays at the midpoint. The slivers lie at the edge of the area searched
/// for obstacles, so a search that reaches less far on any side misses one.
fn ring(size: f64) -> [BoundingBox; 5] {
    let half = size / 2.0;
    [
        rect(375.0, 175.0, 250.0, 250.0),
        rect(500.0 - 128.0 - half - 1.0, 300.0 - half, 1.1, size),
        rect(500.0 + 128.0 + half - 0.1, 300.0 - half, 1.1, size),
        rect(500.0 - half, 300.0 - 128.0 - half - 1.0, size, 1.1),
        rect(500.0 - half, 300.0 + 128.0 + half - 0.1, size, 1.1),
    ]
}

#[test]
fn every_spot_within_reach_covered_leaves_the_label_at_the_midpoint() {
    let long = [at(0.0, 300.0), at(1000.0, 300.0)];
    assert_eq!(placed(&long, 4.0, 4.0, &ring(4.0)), Some(at(500.0, 300.0)));
    assert_eq!(placed(&long, 0.5, 0.5, &ring(0.5)), Some(at(500.0, 300.0)));
}

#[test]
fn the_label_slides_to_the_first_spot_past_a_covering_box() {
    let long = [at(0.0, 300.0), at(1000.0, 300.0)];
    let core = [rect(375.0, 175.0, 250.0, 250.0)];
    assert_eq!(placed(&long, 4.0, 4.0, &core), Some(at(372.0, 300.0)));
}

/// Far from the origin a spot's box, rounded, reaches a ten-thousandth of a
/// pixel past the slide's reach: the pixel of margin on the searched area is
/// what keeps the box there in the search.
#[test]
fn the_searched_area_holds_a_spot_rounded_past_the_reach() {
    let x = 1_099_511_627_776.0;
    let path = [at(x - 500.0, 0.0), at(x + 500.0, 0.0)];
    let obstacles = [
        rect(1_099_511_627_651.0, -125.0, 250.0, 250.0),
        rect(1_099_511_627_646.0, -1.0, 1.9, 2.0),
        rect(1_099_511_627_904.15, -1.0, 1.0, 2.0),
    ];
    assert_eq!(placed(&path, 0.3, 0.3, &obstacles), Some(at(x, -128.0)));
}

/// Off a vertical line the left side comes before the right.
#[test]
fn off_a_vertical_line_the_label_tries_the_left_first() {
    let path = [at(500.0, 0.0), at(500.0, 1000.0)];
    let along = [rect(495.0, 400.0, 10.0, 200.0)];
    assert_eq!(placed(&path, 20.0, 10.0, &along), Some(at(484.0, 500.0)));
}

/// A corridor along a 40px line: walls above and below, and `block` filling it
/// from one side.
fn corridor(block: BoundingBox) -> [BoundingBox; 3] {
    [rect(-1000.0, -1000.0, 3000.0, 1194.0), rect(-1000.0, 206.0, 3000.0, 1000.0), block]
}

/// Along the line the label slides only as far as the line runs, either way:
/// a clear spot past its end is not taken.
#[test]
fn the_slide_along_a_line_stops_where_the_line_ends() {
    let short = [at(100.0, 200.0), at(140.0, 200.0)];
    let ahead = corridor(rect(-1000.0, 194.0, 1136.0, 12.0));
    assert_eq!(placed(&short, 10.0, 10.0, &ahead), Some(at(120.0, 200.0)));
    let behind = corridor(rect(102.0, 194.0, 2000.0, 12.0));
    assert_eq!(placed(&short, 10.0, 10.0, &behind), Some(at(120.0, 200.0)));
    let room = corridor(rect(-1000.0, 194.0, 1131.0, 12.0));
    assert_eq!(placed(&short, 10.0, 10.0, &room), Some(at(136.0, 200.0)));
}
