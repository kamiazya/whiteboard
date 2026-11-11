//! The sketch ink against the TypeScript's own strokes, seed for seed.
//!
//! Every stroke is a pure function of its geometry and seed, so these are exact:
//! one wrong constant, or one random draw consumed in a different order, moves a
//! coordinate. Shapes and their silhouettes are those the TypeScript drew.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::edge_arrows::edge_arrow_polygons;
use whiteboard_canvas_render::ink::{SketchEdgeOptions, sketch_edge, sketch_shape};
use whiteboard_model::spatial::EdgeSide;
use whiteboard_scene::{
    BoundingBox, EdgeEnd, EdgeJumpPoint, NodeOutline, ResolvedEdgeNode, ScenePoint,
};

fn at(x: f64, y: f64) -> ScenePoint {
    ScenePoint { x, y }
}

fn bbox(w: f64, h: f64) -> BoundingBox {
    BoundingBox { x: 0.0, y: 0.0, w, h }
}

fn jumps() -> Vec<EdgeJumpPoint> {
    vec![
        EdgeJumpPoint { segment: 0.0, x: 20.0, y: 0.0 },
        EdgeJumpPoint { segment: 1.0, x: 40.0, y: 15.0 },
    ]
}

fn corner() -> Vec<ScenePoint> {
    vec![at(0.0, 0.0), at(40.0, 0.0), at(40.0, 30.0)]
}

#[test]
fn a_rounded_edge_with_hops_is_two_bowed_passes_over_its_flattened_line() {
    let options = SketchEdgeOptions { arrows: &[], rounded: true, jumps: &jumps() };
    let strokes = sketch_edge(&corner(), 12345, &options);
    assert_eq!(
        strokes,
        [
            "M 1.15 -0.46 Q 11.72 0.07 19.99 0.3 Q 22.28 0.07 24.7 0.11 Q 26.51 0.52 28.44 1.13 Q 30.74 1.58 32.51 2.32 Q 33.42 2.79 34.98 4.02 Q 36.16 4.91 37.42 6.14 Q 37.92 7.02 38.83 8.29 Q 39.07 9.51 39.67 11.36 Q 39.91 13.56 40.19 15.26 Q 39.93 22.94 40.35 30.67",
            "M 1.05 -1.11 Q 9.58 -0.2 20.06 0.38 Q 22.15 0.16 24.76 0.52 Q 27.29 0.71 28.72 0.76 Q 30.28 1.41 32.03 2.12 Q 33.68 2.95 35.13 3.63 Q 36.11 4.79 36.94 6.07 Q 38.1 7.42 38.71 8.67 Q 39.12 9.72 39.46 11.17 Q 39.8 13.03 39.78 15.18 Q 40.12 24.56 39.82 30.55",
        ]
    );
}

#[test]
fn each_arrowhead_adds_two_wing_strokes_after_the_passes() {
    let path = [at(0.0, 0.0), at(100.0, 0.0), at(100.0, 60.0)];
    let edge = ResolvedEdgeNode {
        id: "e".into(),
        jumps: None,
        path: path.to_vec(),
        from_side: EdgeSide::Left,
        to_side: EdgeSide::Top,
        from_end: EdgeEnd::Arrow,
        to_end: EdgeEnd::Arrow,
        rounded: false,
        ink: None,
        comment_chrome: false,
        appearance: Some(whiteboard_scene::Appearance {
            stroke_width: Some(4.0),
            ..whiteboard_scene::Appearance::default()
        }),
    };
    let arrows = edge_arrow_polygons(&edge);
    let options = SketchEdgeOptions { arrows: &arrows, rounded: false, jumps: &[] };
    assert_eq!(
        sketch_edge(&path, 5, &options),
        [
            "M 0.46 0.65 Q 12.24 -0.12 24.33 0.3 Q 40.47 -0.13 49 0.22 Q 64.41 0.13 75.53 -0.1 Q 85.65 -0.29 100.97 -0.65 Q 100.21 17.64 100.67 30.58 Q 100.27 42.95 100.39 58.83",
            "M -0.07 1.18 Q 12.59 0.18 24.39 -1.01 Q 38.62 -0.22 50.84 -0.44 Q 63.52 0.05 74.78 1.17 Q 86.11 0.17 99.45 -0.27 Q 100.35 15.98 99.32 30.89 Q 100.11 48.89 100.53 60.91",
            "M -0.36 0.9 Q 9.5 -4.09 15.4 -7.18",
            "M 1.2 -1.17 Q 7.04 3.02 15.64 7.02",
            "M 98.98 58.99 Q 97.75 52.99 94.16 44.06",
            "M 98.92 60.56 Q 103.66 52 107.49 43.48",
        ]
    );
}

#[test]
fn a_path_with_no_line_or_a_non_finite_point_is_not_inked() {
    let options = SketchEdgeOptions { arrows: &[], rounded: false, jumps: &[] };
    assert!(sketch_edge(&[at(0.0, 0.0)], 1, &options).is_empty());
    assert!(sketch_edge(&[], 1, &options).is_empty());
    assert!(sketch_edge(&[at(0.0, 0.0), at(f64::NAN, 1.0)], 1, &options).is_empty());
    assert!(sketch_edge(&[at(0.0, 0.0), at(1.0, f64::INFINITY)], 1, &options).is_empty());
    assert!(sketch_edge(&[at(f64::NEG_INFINITY, 0.0), at(1.0, 1.0)], 1, &options).is_empty());
    assert_eq!(sketch_edge(&[at(0.0, 0.0), at(1.0, 1.0)], 1, &options).len(), 2);
}

#[test]
fn a_rect_is_two_passes_and_a_hatch_clipped_to_it() {
    let ink = sketch_shape(None, &bbox(60.0, 40.0), 7, true);
    assert_eq!(
        ink.strokes,
        [
            "M -1.17 -1.05 Q 30.96 0.33 61.14 0.48 Q 60.33 17.09 60.05 39.77 Q 25.25 39.97 -0.08 39.38 Q -0.13 23.63 -1.17 -4.05",
            "M -0.5 0.08 Q 23.78 -0.3 59.51 1.15 Q 59.75 20.57 59.39 40.91 Q 37.66 39.41 -0.74 39.14 Q 0.12 19.36 -0.5 -2.92",
        ]
    );
    assert_eq!(
        ink.hatch,
        Some(
            [
                "M 0.12 7.28 Q 3.51 3.96 9.3 -0.46",
                "M -0.07 15.69 Q 9.69 8.65 20.74 0.27",
                "M -0.03 25.93 Q 14.87 13.9 33.54 0.19",
                "M -0.36 34.43 Q 18.63 20.76 45.93 -0.18",
                "M 5.21 39.54 Q 32.53 19.74 57.88 0.42",
                "M 17.71 40.42 Q 40.96 22.7 59.62 7.58",
                "M 30.2 40.34 Q 49.15 25.23 60.09 17.33",
                "M 42.24 39.51 Q 52.21 32.21 60.02 26.01",
                "M 54.36 40.48 Q 57.03 37.98 60.06 35.81",
            ]
            .iter()
            .map(ToString::to_string)
            .collect()
        )
    );
}

#[test]
fn without_a_hatch_the_hatch_is_absent_and_the_passes_are_the_same() {
    let plain = sketch_shape(None, &bbox(30.0, 20.0), 77, false);
    assert_eq!(plain.hatch, None);
    assert_eq!(
        plain.strokes,
        [
            "M -0.18 -1.1 Q 11 -0.23 30.47 -0.03 Q 29.96 12.46 29.08 20.78 Q 15.04 19.86 0.92 20.68 Q -0.21 10.47 -0.18 -4.1",
            "M -0.89 -1.02 Q 11.72 -0.21 29.8 0.02 Q 30.24 8.31 31.14 18.94 Q 12.16 19.98 -0.51 19.4 Q 0.05 10.14 -0.89 -4.02",
        ]
    );
}

#[test]
fn a_cylinder_is_over_the_cap_down_the_side_under_the_cap_up_and_the_lid() {
    let outline = NodeOutline::Cylinder { x: 0.0, y: 0.0, w: 60.0, h: 40.0, ry: 6.0 };
    let ink = sketch_shape(Some(&outline), &bbox(60.0, 40.0), 9, false);
    assert_eq!(
        ink.strokes,
        [
            "M -0.07 6.08 Q -0.72 5.81 0.94 4.52 Q 1.57 3.73 4.11 3.07 Q 5.99 1.64 8.65 2 Q 12.12 1.53 14.73 0.9 Q 17.94 -0.28 22.4 0.28 Q 26.03 -0.3 29.8 0.4 Q 34.2 -0.33 37.58 0.4 Q 41.66 1.14 45.1 0.71 Q 48.53 0.66 51.23 1.99 Q 54.03 2.04 56.12 2.98 Q 58.01 4.16 59.06 4.38 Q 60.12 5.39 60.04 5.96 M 60.08 6.38 Q 59.93 23.61 59.99 33.23 M 60.03 34.01 Q 59.31 34.92 59.01 35.66 Q 58.04 36.03 56.14 36.81 Q 54.06 37.34 51.35 38.01 Q 48.4 38.3 45.12 39.3 Q 42.09 39.9 38.17 39.99 Q 34.06 40.71 30.37 40.27 Q 26.6 39.26 22.01 39.95 Q 17.97 39.74 15.34 38.92 Q 11.88 38.32 9.04 38.35 Q 5.62 38.31 4.13 36.94 Q 2.27 35.52 1.08 35.51 Q -0.06 34.14 0.05 34.08 M -0.74 33.07 Q 0.22 21.78 -0.78 5.26 M -0.08 6.08 Q 0.6 7.45 1.06 7.63 Q 2.57 8.93 3.97 9.17 Q 6.44 10.27 8.8 10.5 Q 11.35 10.74 15.24 11.18 Q 18.92 11.05 22.03 12.15 Q 25.89 12.1 30.4 11.62 Q 33.98 12.62 37.65 11.66 Q 40.84 11.61 45.29 11.15 Q 47.8 11.16 51.17 10.43 Q 53.85 9.95 56.07 9.02 Q 58.16 7.82 59.05 7.46 Q 59.65 7.05 59.89 6.1",
            "M -0.04 6.09 Q 0.18 5.73 0.94 4.46 Q 1.41 3.4 4.1 2.81 Q 6.77 2.9 8.57 1.57 Q 11.26 1.61 15.02 1.12 Q 17.7 0.56 22.2 -0.07 Q 25.52 0.24 29.97 -0.23 Q 33.64 0.38 38 0.59 Q 41.55 0.42 44.98 1.1 Q 49.1 1.64 51.28 1.54 Q 53.7 1.86 55.82 2.88 Q 58.64 4.2 59.01 4.49 Q 60.78 4.47 60.02 5.98 M 59.2 6.3 Q 59.8 22.03 59.1 34.93 M 59.9 34.08 Q 59.79 34.04 59.03 35.64 Q 57.66 36.6 55.86 36.82 Q 54.46 36.91 51.14 38.32 Q 48.74 38.54 45.2 39.01 Q 41.75 40.37 38.18 39.65 Q 34.71 40.67 30.08 40.15 Q 25.82 40.48 22.44 39.43 Q 18.39 39.25 15.2 39.22 Q 10.83 38.86 8.76 38.15 Q 5.63 38.07 4.11 37.1 Q 2.65 36.53 1.07 35.64 Q 0.43 34.79 0.05 33.93 M -0.5 33.29 Q 0.29 21.01 0.37 5.6 M -0.08 5.97 Q 0.58 7.34 1 7.52 Q 1.95 7.85 3.87 8.83 Q 5.32 10.21 8.91 10.24 Q 12.01 10.89 15.03 11.23 Q 17.66 11.71 22.37 12.01 Q 25.47 11.85 30.11 11.74 Q 33.94 11.97 37.69 11.58 Q 42.37 11.27 44.99 11.24 Q 48.3 10.17 51.39 10.31 Q 53.62 9.87 56.11 9.19 Q 57.56 7.94 58.97 7.63 Q 60.68 6.99 59.92 5.94",
        ]
    );
}

#[test]
fn an_ellipse_is_inked_as_a_sampled_closed_curve() {
    let outline = NodeOutline::Ellipse { cx: 30.0, cy: 20.0, rx: 30.0, ry: 20.0 };
    let ink = sketch_shape(Some(&outline), &bbox(60.0, 40.0), 3, true);
    assert_eq!(
        ink.strokes,
        [
            "M 60.14 19.72 Q 59.99 22.75 58.95 24.91 Q 58.4 28.29 56.16 29.99 Q 54.27 32.08 51.2 33.89 Q 48.72 36.32 44.81 37.36 Q 41.52 39.4 37.5 38.95 Q 34.56 40.34 30.19 39.98 Q 26.33 40.72 22.49 39.65 Q 18.85 37.93 14.86 37.48 Q 10.89 36.06 8.63 34.27 Q 6.58 32.03 4.04 30.22 Q 2.11 27.38 1.05 24.88 Q -0.06 22.72 0.23 19.88 Q 0.13 17.19 1.29 14.99 Q 2.46 11.76 3.97 10.14 Q 6.72 7.95 8.53 5.76 Q 11.98 4.43 15.18 2.27 Q 17.72 1.22 21.8 0.66 Q 25.5 0.31 30.33 0.09 Q 34.39 0.2 37.92 0.93 Q 42.36 2.15 45.07 2.75 Q 49.19 4.13 50.9 5.76 Q 54.62 8.44 56 10.22 Q 58.46 11.99 58.92 14.8 Q 60.2 18.08 60.14 19.72",
            "M 59.93 20.06 Q 59.92 22.42 58.76 25.26 Q 58.74 27.05 56.01 29.84 Q 53.37 31.78 51.49 33.81 Q 47.82 36.59 45.28 36.99 Q 42.01 39.18 37.7 39.66 Q 33.77 39.3 29.57 40.15 Q 25.79 39.62 21.89 39.13 Q 17.83 38.04 15.4 37.34 Q 11.44 35.57 8.55 33.78 Q 5.23 32.35 3.79 30.1 Q 1.99 27.53 1.1 25.38 Q 0.74 23.26 0.12 20.19 Q 0.65 17.03 0.79 14.63 Q 1.76 11.93 3.77 10.07 Q 5.52 8.15 8.92 5.91 Q 10.8 3.51 15.19 2.53 Q 18.22 2.14 22.63 0.33 Q 25.75 0.11 30.42 -0.28 Q 33.41 0.15 37.66 0.68 Q 42.08 0.6 44.95 2.72 Q 49.19 3.7 51.05 5.98 Q 53.34 6.94 55.66 9.98 Q 57.92 12.57 59.15 14.72 Q 60.58 17.43 59.93 20.06",
        ]
    );
    assert_eq!(ink.hatch.map(|h| h.len()), Some(7));
}

#[test]
fn a_polygon_is_inked_along_its_own_corners() {
    let diamond = NodeOutline::Polygon {
        points: vec![at(30.0, 0.0), at(60.0, 20.0), at(30.0, 40.0), at(0.0, 20.0)],
    };
    let ink = sketch_shape(Some(&diamond), &bbox(60.0, 40.0), 11, true);
    assert_eq!(
        ink.strokes,
        [
            "M 30.03 0.07 Q 45.99 10.61 60.26 20.22 Q 45.01 29.63 30.84 40.09 Q 15.8 30.36 -1.01 20.07 Q 16.47 8.67 32.52 -1.59",
            "M 29.23 -0.54 Q 44.1 9.76 59.75 19.7 Q 42.12 31.64 30.2 39.11 Q 16.7 31.01 0.23 20.18 Q 12.55 11.17 31.72 -2.2",
        ]
    );
    assert_eq!(
        ink.hatch,
        Some(
            [
                "M 3.3 21.98 Q 18.32 11.61 32.36 1.26",
                "M 10.44 26.37 Q 23.07 16.53 39.05 6.12",
                "M 16.25 31.46 Q 29.01 22.1 45.29 10.22",
                "M 23.5 35.1 Q 37.19 25.53 52.02 14.13",
                "M 30.34 39.83 Q 40.45 32.5 58.43 18.83",
            ]
            .iter()
            .map(ToString::to_string)
            .collect()
        )
    );
}

#[test]
fn a_box_with_no_area_or_a_non_finite_field_is_not_inked() {
    for bad in [bbox(0.0, 10.0), bbox(10.0, -1.0), bbox(f64::NAN, 10.0), bbox(10.0, f64::INFINITY)]
    {
        let ink = sketch_shape(None, &bad, 1, true);
        assert!(ink.strokes.is_empty() && ink.hatch.is_none());
    }
    assert_eq!(sketch_shape(None, &bbox(30.0, 20.0), 1, false).strokes.len(), 2);
}

fn polygon(points: &[(f64, f64)]) -> NodeOutline {
    NodeOutline::Polygon { points: points.iter().map(|&(x, y)| at(x, y)).collect() }
}

#[test]
fn a_ring_with_a_short_side_shakes_the_vertices_beside_it_less() {
    // The closing side is 5px, so the first vertex is shaken by 5/12 of the amount.
    let thin = polygon(&[(0.0, 0.0), (40.0, 0.0), (40.0, 5.0), (0.0, 5.0)]);
    let ink = sketch_shape(Some(&thin), &bbox(40.0, 5.0), 21, false);
    assert_eq!(
        ink.strokes,
        [
            "M -0.07 -0.05 Q 19.31 0.27 39.78 -0.12 Q 40.02 2.03 39.98 5.39 Q 18.64 5.15 0.37 4.85 Q 0.05 3.1 -0.07 -3.05",
            "M -0.29 0.05 Q 15.17 0.16 40.32 -0.45 Q 39.95 2.96 39.99 4.73 Q 18.21 4.91 0.05 4.97 Q -0.02 2.97 -0.29 -2.95",
        ]
    );
}

#[test]
fn a_ring_of_one_vertex_is_inked_without_a_neighbour_to_shorten_its_shake() {
    let one = polygon(&[(5.0, 5.0)]);
    let ink = sketch_shape(Some(&one), &bbox(10.0, 10.0), 22, false);
    assert_eq!(ink.strokes, ["M 5.29 4.37 Q 5 5 5.29 4.37", "M 4.67 5.95 Q 5 5 4.67 5.95",]);
    let none = polygon(&[]);
    let empty = sketch_shape(Some(&none), &bbox(10.0, 10.0), 26, true);
    assert_eq!(empty.strokes, ["", ""]);
    assert_eq!(empty.hatch, Some(Vec::new()));
}

#[test]
fn a_closing_side_of_no_length_overshoots_nowhere() {
    let ring = polygon(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 0.0)]);
    let ink = sketch_shape(Some(&ring), &bbox(10.0, 10.0), 23, false);
    assert_eq!(
        ink.strokes,
        [
            "M 0 0 Q 5.98 -0.12 10.26 -0.39 Q 10.07 5.63 9.65 9.43 Q 6.36 6.12 0 0 Q 0 0 0 0",
            "M 0 0 Q 4.07 0.07 9.9 0.31 Q 9.95 3.97 10.97 9.43 Q 5.39 5.38 0 0 Q 0 0 0 0",
        ]
    );
}

#[test]
fn an_open_line_is_not_shortened_by_how_near_its_end_comes_back_to_its_start() {
    let options = SketchEdgeOptions { arrows: &[], rounded: false, jumps: &[] };
    let back = [at(0.0, 0.0), at(50.0, 0.0), at(3.0, 0.0)];
    assert_eq!(
        sketch_edge(&back, 24, &options),
        [
            "M -0.4 1.11 Q 15.33 0.17 24.51 -0.99 Q 38.58 -0.1 50.06 -0.92 Q 32.28 0.07 2.45 -0.1",
            "M 0.41 -0.34 Q 15.99 0.08 26.05 1 Q 38.69 -0.22 50.02 -0.43 Q 30.89 -0.33 3.67 -0.28",
        ]
    );
    let short = [at(0.0, 0.0), at(8.0, 0.0)];
    assert_eq!(
        sketch_edge(&short, 25, &options),
        ["M 0.16 0.53 Q 3.46 -0.08 8.12 0.39", "M -0.12 -0.08 Q 3.4 -0.09 7.74 -0.4",]
    );
}

#[test]
fn a_box_too_small_for_a_hatch_line_has_none_and_a_moved_box_hatches_where_it_is() {
    let tiny = sketch_shape(None, &bbox(5.0, 5.0), 27, true);
    assert_eq!(
        tiny.strokes,
        [
            "M -0.1 -0.47 Q 2.46 0 4.52 -0.33 Q 5 2.34 5.33 4.74 Q 2.56 5.02 -0.23 4.59 Q -0.06 2.94 -0.1 -3.47",
            "M 0.09 -0.15 Q 3.03 -0.04 5.23 0.39 Q 5.04 2.25 5.11 4.91 Q 2.96 5.04 0.3 4.75 Q 0.02 2.31 0.09 -3.15",
        ]
    );
    assert_eq!(tiny.hatch, Some(Vec::new()));
    let moved = BoundingBox { x: 10.0, y: 10.0, w: 30.0, h: 20.0 };
    let ink = sketch_shape(None, &moved, 28, true);
    assert_eq!(
        ink.strokes,
        [
            "M 9.83 10.5 Q 29.18 9.95 40.57 10.59 Q 39.84 22.52 39.46 29.48 Q 21.51 30.31 9.83 29 Q 10.2 21.04 9.83 7.5",
            "M 10.9 8.91 Q 27.93 9.82 39.33 11.12 Q 40.11 22.18 39.22 29.6 Q 22.67 29.92 9.46 29.81 Q 9.96 22.18 10.9 5.91",
        ]
    );
    assert_eq!(
        ink.hatch,
        Some(
            [
                "M 9.55 17.47 Q 14.97 12.77 19.6 10.4",
                "M 9.87 25.68 Q 21.35 16.79 30.41 10.16",
                "M 14.62 29.93 Q 29.05 18.87 39.64 10.64",
                "M 25.81 29.91 Q 32.18 25.18 40.25 19.61",
                "M 37.03 30 Q 38.26 28.3 40.46 27.09",
            ]
            .iter()
            .map(ToString::to_string)
            .collect()
        )
    );
}

/// FNV-1a over the bytes of a text, 64 bits: a digest the TypeScript computed
/// over the same text, so a sweep of many seeds is one comparison.
fn digest(text: &str) -> String {
    let hash = text
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:x}")
}

fn sweep(outline: Option<&NodeOutline>, bbox: &BoundingBox) -> (String, usize) {
    let mut text = String::new();
    let mut lines = 0;
    for seed in 0..80_u32 {
        let ink = sketch_shape(outline, bbox, seed * 7919 + 3, true);
        let hatch = ink.hatch.unwrap_or_default();
        lines += hatch.len();
        for piece in [&ink.strokes.join("|"), "#", &hatch.join("|"), "\n"] {
            text.push_str(piece);
        }
    }
    (digest(&text), lines)
}

type SweepCase = (&'static str, Option<NodeOutline>, BoundingBox, &'static str, usize);

fn silhouette_cases() -> Vec<SweepCase> {
    let ellipse = NodeOutline::Ellipse { cx: 30.0, cy: 20.0, rx: 30.0, ry: 20.0 };
    let cylinder = NodeOutline::Cylinder { x: 0.0, y: 0.0, w: 60.0, h: 40.0, ry: 6.0 };
    vec![
        ("rect", None, bbox(60.0, 40.0), "80e78a08778a940c", 880),
        ("ellipse", Some(ellipse), bbox(60.0, 40.0), "e89b48874ac566f5", 662),
        (
            "diamond clockwise",
            Some(polygon(&[(30.0, 0.0), (60.0, 20.0), (30.0, 40.0), (0.0, 20.0)])),
            bbox(60.0, 40.0),
            "d80d5a50608db728",
            512,
        ),
        (
            "diamond counter-clockwise",
            Some(polygon(&[(30.0, 0.0), (0.0, 20.0), (30.0, 40.0), (60.0, 20.0)])),
            bbox(60.0, 40.0),
            "d6c711405f08c803",
            512,
        ),
        (
            "hexagon",
            Some(polygon(&[
                (15.0, 0.0),
                (45.0, 0.0),
                (60.0, 20.0),
                (45.0, 40.0),
                (15.0, 40.0),
                (0.0, 20.0),
            ])),
            bbox(60.0, 40.0),
            "f15eb1415f8d3dbf",
            673,
        ),
        ("cylinder", Some(cylinder), bbox(60.0, 40.0), "4eb9ba6e262bbab1", 817),
        (
            "sliver",
            Some(polygon(&[(0.0, 0.0), (60.0, 0.0), (60.0, 1.5), (0.0, 1.5)])),
            bbox(60.0, 1.5),
            "89295c3885712d6e",
            512,
        ),
    ]
}

fn degenerate_cases() -> Vec<SweepCase> {
    vec![
        (
            "triangle",
            Some(polygon(&[(0.0, 40.0), (60.0, 40.0), (30.0, 0.0)])),
            bbox(60.0, 40.0),
            "97a8b4c6a808282",
            674,
        ),
        (
            "two points",
            Some(polygon(&[(0.0, 0.0), (60.0, 40.0)])),
            bbox(60.0, 40.0),
            "92ed6aad6705387a",
            0,
        ),
        ("one point", Some(polygon(&[(5.0, 5.0)])), bbox(60.0, 40.0), "a6b15796d82e5d2d", 0),
        (
            "collinear",
            Some(polygon(&[(0.0, 0.0), (30.0, 20.0), (60.0, 40.0)])),
            bbox(60.0, 40.0),
            "f24271ac8bbae6d9",
            0,
        ),
        ("no points", Some(polygon(&[])), bbox(60.0, 40.0), "a23f50096e0d7b55", 0),
        (
            "needle",
            Some(polygon(&[(0.0, 0.0), (60.0, 0.2), (0.0, 0.4)])),
            bbox(60.0, 40.0),
            "f755637426e3c2ad",
            0,
        ),
        (
            "wide",
            Some(polygon(&[(0.0, 0.0), (600.0, 0.0), (600.0, 400.0), (0.0, 400.0)])),
            bbox(600.0, 400.0),
            "3abc4c17b6f74f91",
            9030,
        ),
    ]
}

/// Hatching, which clips a slanted line to a convex region (Cyrus-Beck), over 80
/// seeds of each silhouette: either winding of a polygon, a sliver, a triangle,
/// curves. A hash and a count of lines per silhouette, from the TypeScript.
#[test]
fn hatching_every_silhouette_over_many_seeds_draws_the_lines_the_typescript_draws() {
    for (name, outline, bbox, hash, lines) in
        silhouette_cases().into_iter().chain(degenerate_cases())
    {
        assert_eq!(sweep(outline.as_ref(), &bbox), (hash.to_string(), lines), "{name}");
    }
}
