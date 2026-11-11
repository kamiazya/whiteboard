// Generated from the TypeScript's own answers (`packages/canvas-render`), one
// expectation per documented rule; points are compared as the text JavaScript
// prints them, which is exact.

//! The edge flattener and the arrowhead geometry against the TypeScript.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::edge_arrows::{
    EdgeEndSide, MarkerDirection, arrow_marker_geometry, edge_arrow_ends, edge_arrow_inset,
    edge_arrow_polygons, edge_arrow_scale,
};
use whiteboard_canvas_render::edge_flatten::{
    flatten_drawn_edge_path, hop_endpoints, jumps_within_span,
};
use whiteboard_det::format::js_number_to_string;
use whiteboard_model::spatial::EdgeSide;
use whiteboard_scene::{EdgeEnd, EdgeJumpPoint, ResolvedEdgeNode, ScenePoint};

fn at(x: f64, y: f64) -> ScenePoint {
    ScenePoint { x, y }
}

fn shown(points: &[ScenePoint]) -> Vec<String> {
    points
        .iter()
        .map(|p| format!("{},{}", js_number_to_string(p.x), js_number_to_string(p.y)))
        .collect()
}

fn jump(segment: f64, x: f64, y: f64) -> EdgeJumpPoint {
    EdgeJumpPoint { segment, x, y }
}

fn corner_path() -> Vec<ScenePoint> {
    vec![at(0.0, 0.0), at(40.0, 0.0), at(40.0, 30.0)]
}

fn corner_jumps() -> Vec<EdgeJumpPoint> {
    vec![jump(0.0, 20.0, 0.0), jump(1.0, 40.0, 15.0)]
}

#[test]
fn a_plain_path_hops_every_jump_on_its_segment() {
    let got = flatten_drawn_edge_path(&corner_path(), &corner_jumps(), false);
    assert_eq!(
        shown(&got),
        [
            "0,0",
            "15,0",
            "15.380602337443566,-1.913417161825449",
            "16.464466094067262,-3.5355339059327373",
            "18.08658283817455,-4.619397662556434",
            "20,-5",
            "21.91341716182545,-4.619397662556434",
            "23.535533905932738,-3.5355339059327378",
            "24.619397662556434,-1.9134171618254494",
            "25,-6.123233995736766e-16",
            "40,0",
            "40,10",
            "41.91341716182545,10.380602337443566",
            "43.53553390593274,11.464466094067262",
            "44.61939766255644,13.08658283817455",
            "45,15",
            "44.61939766255644,16.91341716182545",
            "43.53553390593274,18.535533905932738",
            "41.91341716182545,19.619397662556434",
            "40,20",
            "40,30",
        ]
    );
}

#[test]
fn a_rounded_path_drops_a_hop_without_clearance_and_keeps_the_corner_curve() {
    let got = flatten_drawn_edge_path(&corner_path(), &corner_jumps(), true);
    assert_eq!(
        shown(&got),
        [
            "0,0",
            "20,0",
            "24.6875,0.234375",
            "28.75,0.9375",
            "32.1875,2.109375",
            "35,3.75",
            "37.1875,5.859375",
            "38.75,8.4375",
            "39.6875,11.484375",
            "40,15",
            "40,30",
        ]
    );
}

#[test]
fn a_rounded_path_with_no_jumps_is_the_corner_curve_alone() {
    let got = flatten_drawn_edge_path(&corner_path(), &[], true);
    assert_eq!(
        shown(&got),
        [
            "0,0",
            "20,0",
            "24.6875,0.234375",
            "28.75,0.9375",
            "32.1875,2.109375",
            "35,3.75",
            "37.1875,5.859375",
            "38.75,8.4375",
            "39.6875,11.484375",
            "40,15",
            "40,30",
        ]
    );
    let plain = flatten_drawn_edge_path(&corner_path(), &[], false);
    assert_eq!(shown(&plain), ["0,0", "40,0", "40,30"]);
}

#[test]
fn a_rounded_path_of_two_points_hops_inside_the_whole_span() {
    let path = [at(0.0, 0.0), at(60.0, 0.0)];
    let got = flatten_drawn_edge_path(&path, &[jump(0.0, 30.0, 0.0)], true);
    assert_eq!(
        shown(&got),
        [
            "0,0",
            "25,0",
            "25.380602337443566,-1.913417161825449",
            "26.464466094067262,-3.5355339059327373",
            "28.08658283817455,-4.619397662556434",
            "30,-5",
            "31.91341716182545,-4.619397662556434",
            "33.53553390593274,-3.5355339059327378",
            "34.61939766255644,-1.9134171618254494",
            "35,-6.123233995736766e-16",
            "60,0",
        ]
    );
    // A hop too near the end has no room for its arc, so it is not drawn.
    let near = flatten_drawn_edge_path(&path, &[jump(0.0, 58.0, 0.0)], true);
    assert_eq!(shown(&near), ["0,0", "60,0"]);
}

#[test]
fn an_empty_path_flattens_to_nothing_with_or_without_jumps() {
    assert!(flatten_drawn_edge_path(&[], &corner_jumps(), false).is_empty());
    assert!(flatten_drawn_edge_path(&[], &corner_jumps(), true).is_empty());
    assert!(flatten_drawn_edge_path(&[], &[], true).is_empty());
}

#[test]
fn jumps_within_a_span_are_those_on_the_segment_with_room_for_the_arc() {
    let span = jumps_within_span(&corner_jumps(), 0, at(0.0, 0.0), at(40.0, 0.0));
    assert_eq!(span, [jump(0.0, 20.0, 0.0)]);
    assert!(jumps_within_span(&corner_jumps(), 1, at(0.0, 0.0), at(40.0, 0.0)).is_empty());
    assert!(jumps_within_span(&corner_jumps(), 0, at(0.0, 0.0), at(0.0, 0.0)).is_empty());
    // Clearance is strictly more than the radius (5) from either end.
    let edge = |x| jumps_within_span(&[jump(0.0, x, 0.0)], 0, at(0.0, 0.0), at(40.0, 0.0)).len();
    assert_eq!([edge(5.0), edge(5.5), edge(34.5), edge(35.0)], [0, 1, 1, 0]);
}

#[test]
fn a_hop_lands_one_radius_either_side_of_the_crossing() {
    let hop = hop_endpoints(at(0.0, 0.0), at(0.0, 10.0), at(0.0, 5.0));
    assert_eq!(hop, Some((at(0.0, 0.0), at(0.0, 10.0))));
    let sideways = hop_endpoints(at(0.0, 0.0), at(100.0, 0.0), at(50.0, 0.0));
    assert_eq!(sideways, Some((at(45.0, 0.0), at(55.0, 0.0))));
    assert!(hop_endpoints(at(1.0, 1.0), at(1.0, 1.0), at(1.0, 1.0)).is_none());
}

fn edge(
    path: Vec<ScenePoint>,
    width: Option<f64>,
    from_end: EdgeEnd,
    to_end: EdgeEnd,
) -> ResolvedEdgeNode {
    ResolvedEdgeNode {
        id: "e".into(),
        jumps: None,
        path,
        from_side: EdgeSide::Left,
        to_side: EdgeSide::Top,
        from_end,
        to_end,
        rounded: false,
        ink: None,
        comment_chrome: false,
        appearance: width.map(|w| whiteboard_scene::Appearance {
            stroke_width: Some(w),
            ..whiteboard_scene::Appearance::default()
        }),
    }
}

fn right_angle() -> Vec<ScenePoint> {
    vec![at(0.0, 0.0), at(100.0, 0.0), at(100.0, 60.0)]
}

fn both(path: Vec<ScenePoint>, width: Option<f64>) -> ResolvedEdgeNode {
    edge(path, width, EdgeEnd::Arrow, EdgeEnd::Arrow)
}

#[test]
fn a_head_grows_with_the_line_only_past_the_width_the_fixed_head_reaches() {
    let widths = [
        None,
        Some(0.0),
        Some(1.0),
        Some(2.5),
        Some(3.0),
        Some(5.0),
        Some(-1.0),
        Some(f64::NAN),
        Some(f64::INFINITY),
        Some(10.0),
    ];
    let got: Vec<String> = widths
        .iter()
        .map(|w| js_number_to_string(edge_arrow_scale(&both(right_angle(), *w))))
        .collect();
    assert_eq!(got, ["1", "1", "1", "1", "1.2000000000000002", "2", "1", "1", "1", "4"]);
}

fn heads(edge: &ResolvedEdgeNode) -> Vec<Vec<String>> {
    edge_arrow_polygons(edge).iter().map(|a| shown(&a.points)).collect()
}

#[test]
fn heads_are_the_tip_then_the_two_wings_source_first() {
    let light = heads(&both(right_angle(), None));
    assert_eq!(light, [vec!["0,0", "10,-4", "10,4"], vec!["100,60", "96,50", "104,50"]]);
    let heavy = heads(&both(right_angle(), Some(4.0)));
    assert_eq!(heavy, [vec!["0,0", "16,-6.4", "16,6.4"], vec!["100,60", "93.6,44", "106.4,44"]]);
    let to_only = heads(&edge(right_angle(), Some(4.0), EdgeEnd::None, EdgeEnd::Arrow));
    assert_eq!(to_only, [vec!["100,60", "93.6,44", "106.4,44"]]);
    let from_only = heads(&edge(right_angle(), Some(4.0), EdgeEnd::Arrow, EdgeEnd::None));
    assert_eq!(from_only, [vec!["0,0", "16,-6.4", "16,6.4"]]);
}

#[test]
fn an_end_with_no_direction_draws_no_head() {
    assert!(heads(&both(vec![at(0.0, 0.0)], Some(4.0))).is_empty());
    assert!(heads(&both(vec![at(5.0, 5.0), at(5.0, 5.0)], Some(1.0))).is_empty());
    let stub = both(vec![at(0.0, 0.0), at(0.000_000_5, 0.0), at(50.0, 0.0)], Some(1.0));
    assert_eq!(heads(&stub), [vec!["50,0", "40,4", "40,-4"]]);
    assert_eq!(edge_arrow_ends(&stub), (false, true));
    assert_eq!(edge_arrow_ends(&both(vec![], None)), (false, false));
    assert_eq!(
        edge_arrow_ends(&edge(right_angle(), None, EdgeEnd::None, EdgeEnd::Arrow)),
        (false, true)
    );
    assert_eq!(
        edge_arrow_ends(&edge(right_angle(), None, EdgeEnd::Arrow, EdgeEnd::None)),
        (true, false)
    );
    assert_eq!(
        edge_arrow_ends(&edge(right_angle(), None, EdgeEnd::None, EdgeEnd::None)),
        (false, false)
    );
}

#[test]
fn a_heavy_line_stops_short_of_its_head_by_where_the_head_is_half_a_line_wide() {
    let inset = |e: &ResolvedEdgeNode| {
        [edge_arrow_inset(e, EdgeEndSide::From), edge_arrow_inset(e, EdgeEndSide::To)]
            .map(js_number_to_string)
    };
    assert_eq!(inset(&both(right_angle(), Some(5.0))), ["6.25", "6.25"]);
    assert_eq!(inset(&both(right_angle(), Some(1.0))), ["0", "0"]);
    assert_eq!(inset(&both(vec![at(0.0, 0.0), at(6.25, 0.0)], Some(5.0))), ["0", "0"]);
    let barely = vec![at(0.0, 0.0), at(6.250_001_1, 0.0)];
    assert_eq!(inset(&both(barely, Some(5.0))), ["6.25", "6.25"]);
    assert_eq!(inset(&both(vec![at(0.0, 0.0)], Some(5.0))), ["0", "0"]);
    let long_then_short = vec![at(0.0, 0.0), at(6.250_1, 0.0), at(6.250_1, 9.0)];
    assert_eq!(inset(&both(long_then_short, Some(5.0))), ["6.25", "6.25"]);
}

#[test]
fn a_marker_is_the_same_triangle_in_its_own_viewport() {
    let start = arrow_marker_geometry(MarkerDirection::Start, 2.0, 1.0);
    assert_eq!((start.width, start.height, start.ref_x, start.ref_y), (20.0, 16.0, 1.0, 8.0));
    assert_eq!(shown(&start.points), ["0,8", "20,0", "20,16"]);
    let end = arrow_marker_geometry(MarkerDirection::End, 2.0, 1.0);
    assert_eq!((end.width, end.height, end.ref_x, end.ref_y), (20.0, 16.0, 19.0, 8.0));
    assert_eq!(shown(&end.points), ["20,8", "0,0", "0,16"]);
}

#[test]
fn a_run_exactly_the_minimum_direction_length_still_has_a_head_and_a_shorter_one_has_none() {
    let short = |len: f64| both(vec![at(0.0, 0.0), at(len, 0.0)], None);
    assert_eq!(edge_arrow_ends(&short(1e-6)), (true, true));
    assert_eq!(edge_arrow_ends(&short(9.9e-7)), (false, false));
    assert_eq!(edge_arrow_polygons(&short(1e-6)).len(), 2);
    assert!(edge_arrow_polygons(&short(9.9e-7)).is_empty());
}

#[test]
fn the_inset_is_judged_by_the_length_of_the_terminal_run_wherever_it_sits() {
    let inset = |path: Vec<ScenePoint>| {
        let heavy = both(path, Some(5.0));
        [edge_arrow_inset(&heavy, EdgeEndSide::From), edge_arrow_inset(&heavy, EdgeEndSide::To)]
            .map(js_number_to_string)
    };
    // Five long, off the origin, so a sum of the coordinates would read 105.
    assert_eq!(inset(vec![at(50.0, 0.0), at(55.0, 0.0)]), ["0", "0"]);
    assert_eq!(inset(vec![at(50.0, 3.0), at(50.0, 8.0)]), ["0", "0"]);
    // A run exactly the inset plus the minimum direction length is not longer than it.
    let edge = 6.25 + 1e-6;
    assert_eq!(inset(vec![at(0.0, 0.0), at(edge, 0.0)]), ["0", "0"]);
    assert_eq!(inset(vec![at(0.0, 0.0), at(0.0, edge)]), ["0", "0"]);
}

/// A span's two ends and the masks the TypeScript answered along it and around it.
type Span = ((f64, f64), (f64, f64), &'static str, &'static str);

/// Which of a grid of jumps around, along and past the span `a` to `b` are
/// kept, as `1` and `0` in the order the TypeScript's own probe walked them:
/// 19 by 19 points from -40% to 140% of the span on each axis, then 21 on the line.
fn spans() -> [Span; 6] {
    [
        (
            (10.0, 5.0),
            (50.0, 5.0),
            "000111111111111111000",
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        ),
        (
            (0.0, 0.0),
            (30.0, 40.0),
            "000111111111111111000",
            "0000000011111111111000000001111111111100000001111111111110000000111111111111000000111111111111100000011111111111100000011111111111100000011111111111110000001111111111110000001111111111111000000111111111111000000111111111111100000011111111111100000011111111111100000011111111111110000001111111111110000000111111111111000000011111111111000000001111111111100000000",
        ),
        (
            (100.0, 100.0),
            (60.0, 70.0),
            "000111111111111111000",
            "0000000000000011111000000000000011111100000000000111111110000000001111111111000000011111111111100000011111111111110000111111111111111001111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111001111111111111110000111111111111100000011111111111100000001111111111000000000111111110000000000011111100000000000001111100000000000000",
        ),
        (
            (0.0, 0.0),
            (0.0, 40.0),
            "000111111111111111000",
            "0000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000",
        ),
        (
            (5.0, 50.0),
            (5.0, 10.0),
            "000111111111111111000",
            "0000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000000000111111100000000000011111110000000000001111111000000",
        ),
        (
            (-20.0, 7.0),
            (-60.0, -3.0),
            "000111111111111111000",
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        ),
    ]
}

#[test]
fn a_jump_is_kept_by_where_it_falls_along_the_span_whichever_way_the_span_runs() {
    let spans = spans();
    for ((ax, ay), (bx, by), online, grid) in spans {
        let (a, b) = (at(ax, ay), at(bx, by));
        let keeps = |x: f64, y: f64| {
            let jump = jump(0.0, x, y);
            if jumps_within_span(&[jump], 0, a, b).is_empty() { '0' } else { '1' }
        };
        let mut got_grid = String::new();
        for gx in -4..=14 {
            for gy in -4..=14 {
                let (gx, gy) = (f64::from(gx), f64::from(gy));
                got_grid.push(keeps(ax + (bx - ax) * gx / 10.0, ay + (by - ay) * gy / 10.0));
            }
        }
        let got_online: String = (0..=20)
            .map(f64::from)
            .map(|f| keeps(ax + (bx - ax) * f / 20.0, ay + (by - ay) * f / 20.0))
            .collect();
        assert_eq!(got_online, online, "on the line {a:?} {b:?}");
        assert_eq!(got_grid, grid, "around {a:?} {b:?}");
        // A jump recorded against another segment is never kept.
        assert!(jumps_within_span(&[jump(1.0, ax, ay)], 0, a, b).is_empty());
    }
}
