//! What the sketch ink must satisfy over any geometry and seed, stated apart
//! from the exact strokes `sketch_ink.rs` replays: sketch ink is a pure
//! function of semantic geometry and a seed (ADR-0030 decision 7), so what it
//! draws leaves the geometry by at most `SKETCH_INK_REACH_PX`, the same input
//! draws the same ink twice, and moving the geometry moves the ink with it, the
//! randomness having no positional input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::ink::{
    SKETCH_INK_REACH_PX, SketchEdgeOptions, SketchInk, sketch_edge, sketch_shape,
};
use whiteboard_canvas_render::node_outline::node_outline;
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, any, prop, prop_assert, prop_assert_eq,
};
use whiteboard_proptest::{Floor, check};
use whiteboard_scene::{BoundingBox, ScenePoint};

/// The silhouettes the bundled visual plugin carries; none is the plain rect.
const SHAPES: [Option<&str>; 7] = [
    None,
    Some("visual.ellipse"),
    Some("visual.diamond"),
    Some("visual.hexagon"),
    Some("visual.parallelogram"),
    Some("visual.octagon"),
    Some("visual.cylinder"),
];

/// Every number pair in a path's `d`: end AND control points, which bound a
/// quadratic. A token that is no number stays `NaN`, so a malformed path fails
/// a bound instead of vanishing from it, and so does a path with no pair or
/// an odd count, which `chunks_exact` would otherwise drop silently.
fn points_of(d: &str) -> Vec<ScenePoint> {
    let numbers: Vec<f64> = d
        .split(' ')
        .filter(|token| *token != "M" && *token != "Q")
        .map(|token| token.parse().unwrap_or(f64::NAN))
        .collect();
    assert!(
        !numbers.is_empty() && numbers.len().is_multiple_of(2),
        "a path's coordinates come in pairs, at least one: {d:?}"
    );
    numbers.chunks_exact(2).map(|pair| ScenePoint { x: pair[0], y: pair[1] }).collect()
}

fn paths_of(ink: &SketchInk) -> impl Iterator<Item = &String> {
    ink.strokes.iter().chain(ink.hatch.iter().flatten())
}

fn within(p: ScenePoint, b: &BoundingBox, reach: f64) -> bool {
    p.x >= b.x - reach && p.x <= b.x + b.w + reach && p.y >= b.y - reach && p.y <= b.y + b.h + reach
}

fn boxes() -> impl Strategy<Value = BoundingBox> {
    (-500i32..=500, -500i32..=500, 20i32..=400, 20i32..=300).prop_map(|(x, y, w, h)| BoundingBox {
        x: f64::from(x),
        y: f64::from(y),
        w: f64::from(w),
        h: f64::from(h),
    })
}

fn shapes() -> impl Strategy<Value = Option<&'static str>> {
    prop::sample::select(SHAPES.to_vec())
}

fn paths() -> impl Strategy<Value = Vec<ScenePoint>> {
    prop::collection::vec((0i32..=600, 0i32..=400), 2..=5).prop_map(|points| {
        points.into_iter().map(|(x, y)| ScenePoint { x: f64::from(x), y: f64::from(y) }).collect()
    })
}

#[test]
fn every_stroke_and_hatch_line_of_every_silhouette_stays_within_the_box_plus_the_reach() {
    let silhouetted = Floor::new("a box inked along a non-rect silhouette");
    check((boxes(), any::<u32>(), shapes()), None, |(b, seed, shape)| {
        let outline = shape.and_then(|id| node_outline(id, &b));
        silhouetted.draw(outline.is_some());
        let ink = sketch_shape(outline.as_ref(), &b, seed, true);
        prop_assert!(ink.hatch.is_some());
        for d in paths_of(&ink) {
            for p in points_of(d) {
                prop_assert!(within(p, &b, SKETCH_INK_REACH_PX), "{p:?} left {b:?} in {d}");
            }
        }
        Ok(())
    });
    // Six of the seven draws carry a silhouette, so 200 draws reach well past 100.
    silhouetted.assert(100);
}

#[test]
fn every_edge_stroke_stays_within_the_path_bounds_plus_the_reach() {
    check((paths(), any::<u32>()), None, |(path, seed)| {
        let min = |f: fn(&ScenePoint) -> f64| path.iter().map(f).fold(f64::INFINITY, f64::min);
        let max = |f: fn(&ScenePoint) -> f64| path.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
        let b = BoundingBox {
            x: min(|p| p.x),
            y: min(|p| p.y),
            w: max(|p| p.x) - min(|p| p.x),
            h: max(|p| p.y) - min(|p| p.y),
        };
        let strokes = sketch_edge(
            &path,
            seed,
            &SketchEdgeOptions { arrows: &[], rounded: false, jumps: &[] },
        );
        prop_assert!(!strokes.is_empty());
        for d in &strokes {
            for p in points_of(d) {
                prop_assert!(within(p, &b, SKETCH_INK_REACH_PX), "{p:?} left {b:?} in {d}");
            }
        }
        Ok(())
    });
}

#[test]
fn the_same_geometry_and_seed_draw_the_same_ink_twice() {
    check((boxes(), any::<u32>(), shapes(), paths()), None, |(b, seed, shape, path)| {
        let outline = shape.and_then(|id| node_outline(id, &b));
        prop_assert_eq!(
            sketch_shape(outline.as_ref(), &b, seed, true),
            sketch_shape(outline.as_ref(), &b, seed, true)
        );
        let options = SketchEdgeOptions { arrows: &[], rounded: false, jumps: &[] };
        prop_assert_eq!(sketch_edge(&path, seed, &options), sketch_edge(&path, seed, &options));
        Ok(())
    });
}

#[test]
fn moving_the_box_moves_every_coordinate_with_it() {
    let hatched = Floor::new("a box whose hatch has lines to move");
    check(
        (boxes(), any::<u32>(), shapes(), -300i32..=300, -300i32..=300),
        None,
        |(b, seed, shape, dx, dy)| {
            let (dx, dy) = (f64::from(dx), f64::from(dy));
            let moved = BoundingBox { x: b.x + dx, y: b.y + dy, ..b };
            let ink_at = |at: &BoundingBox| {
                let outline = shape.and_then(|id| node_outline(id, at));
                sketch_shape(outline.as_ref(), at, seed, true)
            };
            let (here, there) = (ink_at(&b), ink_at(&moved));
            let hatch_lines = here.hatch.as_ref().map_or(0, Vec::len);
            hatched.draw(hatch_lines > 0);
            let here: Vec<ScenePoint> = paths_of(&here).flat_map(|d| points_of(d)).collect();
            let there: Vec<ScenePoint> = paths_of(&there).flat_map(|d| points_of(d)).collect();
            prop_assert_eq!(here.len(), there.len());
            // Strokes are rounded to two places on each side of the move, so a
            // coordinate that sat on a rounding boundary differs by one step.
            for (a, c) in here.iter().zip(&there) {
                prop_assert!((c.x - (a.x + dx)).abs() <= 0.0151, "{a:?} to {c:?} by {dx}");
                prop_assert!((c.y - (a.y + dy)).abs() <= 0.0151, "{a:?} to {c:?} by {dy}");
            }
            Ok(())
        },
    );
    hatched.assert(150);
}

#[test]
fn a_different_seed_draws_different_ink() {
    check((boxes(), Just(()), shapes()), None, |(b, (), shape)| {
        let outline = shape.and_then(|id| node_outline(id, &b));
        let ink = |seed| sketch_shape(outline.as_ref(), &b, seed, false);
        prop_assert!(ink(1) != ink(2), "seeds 1 and 2 drew the same ink in {b:?}");
        Ok(())
    });
}
