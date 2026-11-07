//! The rounded corner decomposition: canvas-render's
//! `layout/edges/edge-rounding.ts`, ported function for function. Plain
//! arithmetic in the TypeScript's own evaluation order, so nothing here needs
//! a JS semantics helper.

use crate::geometry::Point;

/// One rounded corner: the quadratic from the incoming segment's midpoint
/// to the outgoing one's, controlled by the corner itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoundedCorner {
    pub enter: Point,
    pub control: Point,
    pub leave: Point,
}

#[expect(
    clippy::manual_midpoint,
    reason = "`f64::midpoint` avoids the overflow `(a + b) / 2` has, which the TypeScript does not"
)]
fn midpoint(a: Point, b: Point) -> Point {
    Point { x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0 }
}

/// Every interior vertex as a quadratic; fewer than three points round
/// nothing.
#[must_use]
pub fn rounded_edge_corners(path: &[Point]) -> Vec<RoundedCorner> {
    path.windows(3)
        .filter_map(|triple| match triple {
            [before, corner, after] => Some(RoundedCorner {
                enter: midpoint(*before, *corner),
                control: *corner,
                leave: midpoint(*corner, *after),
            }),
            _ => None,
        })
        .collect()
}

/// Chord count per corner, as `CORNER_SUBDIVISIONS`.
const CORNER_SUBDIVISIONS: u8 = 8;

/// The rounded edge as a dense polyline, endpoints kept; a path too short to
/// round comes back unchanged.
#[must_use]
pub fn flatten_rounded_edge_path(path: &[Point]) -> Vec<Point> {
    let corners = rounded_edge_corners(path);
    let (Some(&first), Some(&last)) = (path.first(), path.last()) else { return path.to_vec() };
    if corners.is_empty() {
        return path.to_vec();
    }
    let mut points = vec![first];
    for RoundedCorner { enter, control, leave } in corners {
        for step in 0..=CORNER_SUBDIVISIONS {
            let t = f64::from(step) / f64::from(CORNER_SUBDIVISIONS);
            let u = 1.0 - t;
            points.push(Point {
                x: u * u * enter.x + 2.0 * u * t * control.x + t * t * leave.x,
                y: u * u * enter.y + 2.0 * u * t * control.y + t * t * leave.y,
            });
        }
    }
    points.push(last);
    points
}

#[cfg(test)]
mod tests {
    use super::{flatten_rounded_edge_path, rounded_edge_corners};
    use crate::geometry::Point;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn one_corner_flattens_to_nine_points_between_the_two_ends() {
        let path = [p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0)];
        assert_eq!(rounded_edge_corners(&path).len(), 1);
        let flat = flatten_rounded_edge_path(&path);
        assert_eq!(flat.len(), 11);
        assert_eq!(flat.get(1), Some(&p(5.0, 0.0)));
        assert_eq!(flat.get(9), Some(&p(10.0, 5.0)));
        assert_eq!(flatten_rounded_edge_path(&path[..2]), path[..2].to_vec());
    }
}
