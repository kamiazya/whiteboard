//! The edge layer's geometry and ink primitives over flat arrays, for the
//! property differential that holds them to canvas-render's TypeScript
//! (ADR-0054 step 5, QR-21 layer 2).
//!
//! Each export answers a whole batch in one call, so a property crosses the
//! boundary once per run (QR-22b). They are a test surface, not the shape of
//! the port: a layout will call the edge layer once, not these.

use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_edge_routing::edge_geometry::{
    bounding_box_of, midpoint_extent, path_is_clear, path_length, segment_crosses_rect, union_rect,
    without_repeats,
};
use whiteboard_edge_routing::edge_ink::{
    diagonal_ink_through, ink_along_rects, on_either_border, self_retraced_ink, strictly_between,
    tunnelled_ink,
};
use whiteboard_edge_routing::edge_rounding::flatten_rounded_edge_path;
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::segment_intersection::segment_intersection;

/// `det::math::js_round` over an array, one answer per input.
#[wasm_bindgen]
#[must_use]
pub fn det_round(xs: &[f64]) -> Vec<f64> {
    xs.iter().map(|&x| whiteboard_det::math::js_round(x)).collect()
}

fn point(xy: &[f64]) -> Point {
    match xy {
        [x, y, ..] => Point { x: *x, y: *y },
        _ => Point { x: f64::NAN, y: f64::NAN },
    }
}

fn rect(xywh: &[f64]) -> Rect {
    match xywh {
        [x, y, w, h, ..] => Rect { x: *x, y: *y, w: *w, h: *h },
        _ => Rect { x: f64::NAN, y: f64::NAN, w: f64::NAN, h: f64::NAN },
    }
}

fn flag(b: bool) -> f64 {
    if b { 1.0 } else { 0.0 }
}

/// Segment-against-rect and segment-against-segment, per case.
///
/// In: 12 numbers a case, `[a.x, a.y, b.x, b.y, rect x, y, w, h, c.x, c.y,
/// d.x, d.y]`. Out: 3 a case, `[segmentCrossesRect(a, b, rect) as 0/1, then
/// segmentIntersection(a, b, c, d) as x, y, NaN NaN for none]`. A trailing
/// partial case is ignored.
#[wasm_bindgen]
#[must_use]
pub fn edge_segment_tests(cases: &[f64]) -> Vec<f64> {
    cases
        .chunks_exact(12)
        .flat_map(|c| {
            let (a, b, r) =
                (point(c), point(c.get(2..).unwrap_or(&[])), rect(c.get(4..).unwrap_or(&[])));
            let (cc, d) = (point(c.get(8..).unwrap_or(&[])), point(c.get(10..).unwrap_or(&[])));
            let hit = segment_intersection(a, b, cc, d);
            [
                flag(segment_crosses_rect(a, b, r)),
                hit.map_or(f64::NAN, |p| p.x),
                hit.map_or(f64::NAN, |p| p.y),
            ]
        })
        .collect()
}

/// Every path measure of one path against one set of rects.
///
/// In: `[n, then x, y per point, m, then x, y, w, h per rect]`. Out, in order:
/// `pathLength`; `inkAlongRects` on either border and strictly between them
/// (the two predicates edge-rules.ts passes); `tunnelledInk`;
/// `selfRetracedInk`; `diagonalInkThrough`; `pathIsClear` as 0/1;
/// `unionRect` as 4 numbers, NaN for none; `boundingBoxOf` the path as 4;
/// `midpointExtent` the path as span x, span y, origin x, origin y; then
/// `withoutRepeats` and `flattenRoundedEdgePath`, each as its point count
/// and that many x, y pairs. A malformed input answers an empty array.
#[wasm_bindgen]
#[must_use]
pub fn edge_path_measures(input: &[f64]) -> Vec<f64> {
    let Some((path, rects)) = decode_path_and_rects(input) else { return Vec::new() };
    let mut out = vec![
        path_length(&path),
        ink_along_rects(&path, &rects, on_either_border),
        ink_along_rects(&path, &rects, strictly_between),
        tunnelled_ink(&path, &rects),
        self_retraced_ink(&path),
        diagonal_ink_through(&path, &rects),
        flag(path_is_clear(&path, &rects)),
    ];
    let union = union_rect(&rects);
    out.extend(union.map_or([f64::NAN; 4], |r| [r.x, r.y, r.w, r.h]));
    let bounds = bounding_box_of(&path);
    out.extend([bounds.x, bounds.y, bounds.w, bounds.h]);
    let extent = midpoint_extent(&path);
    out.extend([extent.span_x, extent.span_y, extent.origin_x, extent.origin_y]);
    for points in [without_repeats(&path), flatten_rounded_edge_path(&path)] {
        out.push(points_len(&points));
        out.extend(points.iter().flat_map(|p| [p.x, p.y]));
    }
    out
}

#[expect(clippy::cast_precision_loss, reason = "a path's point count is far below 2^53")]
fn points_len(points: &[Point]) -> f64 {
    points.len() as f64
}

/// A count as the TypeScript wrote it: a non-negative whole number.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "checked whole and non-negative first; a count past the input fails the split"
)]
fn count(n: f64) -> Option<usize> {
    (n >= 0.0 && n.fract() == 0.0 && n < 1e9).then_some(n as usize)
}

fn decode_path_and_rects(input: &[f64]) -> Option<(Vec<Point>, Vec<Rect>)> {
    let (&n, rest) = input.split_first()?;
    let (coords, rest) = rest.split_at_checked(count(n)?.checked_mul(2)?)?;
    let (&m, rest) = rest.split_first()?;
    let rect_values = rest.get(..count(m)?.checked_mul(4)?)?;
    if rest.len() != rect_values.len() {
        return None;
    }
    Some((
        coords.chunks_exact(2).map(point).collect(),
        rect_values.chunks_exact(4).map(rect).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{det_round, edge_path_measures, edge_segment_tests};

    #[test]
    fn the_segment_export_answers_three_numbers_a_case() {
        let out =
            edge_segment_tests(&[-5.0, 5.0, 15.0, 5.0, 0.0, 0.0, 10.0, 10.0, 5.0, -5.0, 5.0, 15.0]);
        assert_eq!(out, vec![1.0, 5.0, 5.0]);
    }

    #[test]
    fn the_path_export_refuses_a_count_the_input_does_not_hold() {
        assert!(edge_path_measures(&[3.0, 0.0, 0.0]).is_empty());
        assert!(edge_path_measures(&[0.0, 1.0]).is_empty());
        let measures = edge_path_measures(&[2.0, 0.0, 0.0, 3.0, 4.0, 0.0]);
        assert_eq!(measures.first(), Some(&5.0));
        assert_eq!(det_round(&[2.5, -2.5]), vec![3.0, -2.0]);
    }
}
