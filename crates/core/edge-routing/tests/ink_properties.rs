//! `diagonal_ink_through` as properties: it agrees with a sampled estimate of
//! each diagonal chord strictly inside each rect, it moves with the board,
//! and it reads nothing off an axis-aligned path, which the axis terms own.
//!
//! The TypeScript twin is `diagonal-ink.properties.test.ts`. The oracle samples
//! the segment instead of clipping it, so it shares no arithmetic with the
//! Liang-Barsky clip under test; lengths are a plain `sqrt`, never det's hypot.

#![expect(clippy::float_cmp, reason = "an axis-aligned segment keeps one coordinate exactly")]

use whiteboard_edge_routing::edge_ink::diagonal_ink_through;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn point() -> impl Strategy<Value = Point> {
    (-200i32..=200, -200i32..=200).prop_map(|(x, y)| Point { x: f64::from(x), y: f64::from(y) })
}

fn rects() -> impl Strategy<Value = Vec<Rect>> {
    let rect = (-150i32..=150, -150i32..=150, 1i32..=120, 1i32..=120).prop_map(|(x, y, w, h)| {
        Rect { x: f64::from(x), y: f64::from(y), w: f64::from(w), h: f64::from(h) }
    });
    prop::collection::vec(rect, 1..=4)
}

fn path() -> impl Strategy<Value = Vec<Point>> {
    prop::collection::vec(point(), 2..=5)
}

fn length(a: Point, b: Point) -> f64 {
    ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)).sqrt()
}

const SAMPLES: u32 = 4000;

/// The oracle: sample each diagonal segment and count what lands strictly
/// inside each rect.
fn sampled(path: &[Point], rects: &[Rect]) -> f64 {
    let mut total = 0.0;
    for pair in path.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if a.x == b.x || a.y == b.y {
            continue;
        }
        for r in rects {
            let inside = (0..SAMPLES)
                .filter(|k| {
                    let at = (f64::from(*k) + 0.5) / f64::from(SAMPLES);
                    let p = Point { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at };
                    p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
                })
                .count();
            let inside = f64::from(u32::try_from(inside).unwrap_or(SAMPLES));
            total += inside / f64::from(SAMPLES) * length(a, b);
        }
    }
    total
}

#[test]
fn agrees_with_a_sampled_estimate_of_the_chord_strictly_inside_each_rect() {
    let crossing = Floor::new("a path with diagonal ink inside a rect");
    check((path(), rects()), Some(150), |(path, rects)| {
        let ink = diagonal_ink_through(&path, &rects);
        crossing.draw(ink > 0.0);
        // The estimate is off by at most one sample step per rect per segment.
        let step =
            path.windows(2).map(|w| length(w[0], w[1])).fold(0.0, f64::max) / f64::from(SAMPLES);
        let segments = f64::from(u32::try_from(path.len() - 1).unwrap_or(0));
        let count = f64::from(u32::try_from(rects.len()).unwrap_or(0));
        let slack = 2.0 * step * count * segments + 1e-9;
        let estimate = sampled(&path, &rects);
        prop_assert!(
            (ink - estimate).abs() <= slack,
            "ink {ink}, sampled {estimate}, slack {slack}"
        );
        Ok(())
    });
    // Measured 70 to 85 of 150.
    crossing.assert(40);
}

#[test]
fn is_equivariant_under_translation_and_never_longer_than_the_path() {
    check((path(), rects(), point()), Some(150), |(path, rects, d)| {
        let moved_path: Vec<Point> =
            path.iter().map(|p| Point { x: p.x + d.x, y: p.y + d.y }).collect();
        let moved_rects: Vec<Rect> =
            rects.iter().map(|r| Rect { x: r.x + d.x, y: r.y + d.y, ..*r }).collect();
        let ink = diagonal_ink_through(&path, &rects);
        let moved = diagonal_ink_through(&moved_path, &moved_rects);
        prop_assert!((moved - ink).abs() < 1e-6, "{ink} moved to {moved}");
        let total: f64 = path.windows(2).map(|w| length(w[0], w[1])).sum();
        let count = f64::from(u32::try_from(rects.len()).unwrap_or(0));
        prop_assert!(ink >= 0.0 && ink <= total * count + 1e-9, "{ink} against a path of {total}");
        Ok(())
    });
}

#[test]
fn reads_nothing_off_an_axis_aligned_path() {
    let coordinates = prop::collection::vec(-200i32..=200, 2..=5);
    check((coordinates, rects()), Some(80), |(vs, rects)| {
        let y = 7.0;
        let horizontal: Vec<Point> = vs.iter().map(|v| Point { x: f64::from(*v), y }).collect();
        let vertical: Vec<Point> = vs.iter().map(|v| Point { x: y, y: f64::from(*v) }).collect();
        prop_assert!(diagonal_ink_through(&horizontal, &rects) == 0.0);
        prop_assert!(diagonal_ink_through(&vertical, &rects) == 0.0);
        Ok(())
    });
}
