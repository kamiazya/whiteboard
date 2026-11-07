//! The router's leaf modules over flat arrays, for the property
//! differential that holds them to canvas-render's `side-slides.ts`,
//! `straight-detour.ts`, `edge-sides.ts`, `edge-contact.ts` and
//! `bend-route.ts` (ADR-0054 step 5, QR-21 layer 2). Batched test
//! surface like [`crate::edge_primitives`]. A side travels as its index in
//! `edgeSideSchema.options` order (top, right, bottom, left).

use crate::edge_primitives::{count, point, points_len_of, rect};
use crate::routing_wire::{Wire, side_index, side_of};
use wasm_bindgen::prelude::wasm_bindgen;
use whiteboard_edge_routing::bend_route::{BendRouteEnds, bend_route};
use whiteboard_edge_routing::edge_contact::{contact_for, marks_contact};
use whiteboard_edge_routing::edge_geometry::{Side, segment_crosses_rect};
use whiteboard_edge_routing::edge_sides::{initial_side_choices, self_edge_loop_control_points};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::routing_input::rect_at_end;
use whiteboard_edge_routing::side_slides::{
    FacingEnds, deepened_corridor, slid_for_approach, slide_along_side, try_zero_bend_slide,
};
use whiteboard_edge_routing::straight_detour::{
    DetourObstacle, SquareEnds, approaches_sideways, corner_detour, square_ends, strict_interior,
};

/// A side by its `edgeSideSchema.options` index; anything else reads as top.
fn side(index: f64) -> Side {
    side_of(index).unwrap_or(Side::Top)
}

fn points_out(points: Option<Vec<Point>>) -> Vec<f64> {
    match points {
        None => vec![-1.0],
        Some(points) => {
            let mut out = vec![points_len_of(points.len())];
            out.extend(points.iter().flat_map(|p| [p.x, p.y]));
            out
        }
    }
}

fn facing_ends(c: &[f64]) -> FacingEnds {
    let at = |i: usize| c.get(i).copied().unwrap_or(f64::NAN);
    FacingEnds {
        start: point(c),
        end: point(c.get(2..).unwrap_or(&[])),
        from_side: side(at(4)),
        to_side: side(at(5)),
        from_rect: rect(c.get(6..).unwrap_or(&[])),
        to_rect: rect(c.get(10..).unwrap_or(&[])),
    }
}

/// The side-slide answers per case.
///
/// In: 19 numbers a case, `[start, end, from side, to side, from rect, to
/// rect, to normal, from depth, target]` (points as x, y; rects as x, y, w,
/// h). Out: 11 a case: `slideAlongSide(start, fromRect, fromSide, target)`
/// as found 0/1 then x, y (NaN NaN for none); `slidForApproach` as x, y;
/// `deepenedCorridor`; `approachesSideways(start, end, fromSide)` as 0/1;
/// `strictInterior(fromRect)` as 4.
#[wasm_bindgen]
#[must_use]
pub fn edge_side_slides(cases: &[f64]) -> Vec<f64> {
    cases
        .chunks_exact(19)
        .flat_map(|c| {
            let ends = facing_ends(c);
            let to_normal = point(c.get(14..).unwrap_or(&[]));
            let from_depth = c.get(16).copied().unwrap_or(f64::NAN);
            let target = point(c.get(17..).unwrap_or(&[]));
            let slid = slide_along_side(ends.start, ends.from_rect, ends.from_side, target);
            let approach = slid_for_approach(&ends, to_normal);
            let depth = deepened_corridor(
                ends.start,
                ends.end,
                (ends.from_side, ends.to_side),
                from_depth,
                to_normal,
            );
            let inner = strict_interior(ends.from_rect);
            [
                if slid.is_some() { 1.0 } else { 0.0 },
                slid.map_or(f64::NAN, |p| p.x),
                slid.map_or(f64::NAN, |p| p.y),
                approach.x,
                approach.y,
                depth,
                if approaches_sideways(ends.start, ends.end, ends.from_side) { 1.0 } else { 0.0 },
                inner.x,
                inner.y,
                inner.w,
                inner.h,
            ]
        })
        .collect()
}

fn rects_then(values: &[f64]) -> Option<Vec<Rect>> {
    let (&m, rest) = values.split_first()?;
    let body = rest.get(..count(m)?.checked_mul(4)?)?;
    (body.len() == rest.len()).then(|| body.chunks_exact(4).map(rect).collect())
}

/// `tryZeroBendSlide` of one case.
///
/// In: `[the first 14 numbers of an edge_side_slides case, m, then x, y, w, h
/// per inflated obstacle]`. Out: the route as a count and x, y pairs, `-1`
/// for none, and an empty array for a malformed input.
#[wasm_bindgen]
#[must_use]
pub fn edge_zero_bend_slide(input: &[f64]) -> Vec<f64> {
    let (Some(head), Some(obstacles)) = (input.get(..14), input.get(14..).and_then(rects_then))
    else {
        return Vec::new();
    };
    points_out(try_zero_bend_slide(&facing_ends(head), &obstacles))
}

/// `cornerDetour` of one case.
///
/// In: `[start, end, clearance, n, then block x, y, w, h, body x, y, w, h and
/// escapable 0/1 per obstacle]`. Out: the route as a count and x, y pairs,
/// `-1` for none, and an empty array for a malformed input.
#[wasm_bindgen]
#[must_use]
pub fn edge_corner_detour(input: &[f64]) -> Vec<f64> {
    let decoded = (|| {
        let (head, rest) = input.split_first_chunk::<6>()?;
        let [sx, sy, ex, ey, clearance, n] = *head;
        let body = rest.get(..count(n)?.checked_mul(9)?)?;
        let obstacles: Vec<DetourObstacle> = body
            .chunks_exact(9)
            .map(|o| DetourObstacle {
                block: rect(o),
                body: rect(o.get(4..).unwrap_or(&[])),
                escapable: o.get(8).is_some_and(|&e| e != 0.0),
            })
            .collect();
        (body.len() == rest.len()).then_some((
            Point { x: sx, y: sy },
            Point { x: ex, y: ey },
            clearance,
            obstacles,
        ))
    })();
    let Some((start, end, clearance, obstacles)) = decoded else { return Vec::new() };
    points_out(corner_detour(start, end, &obstacles, clearance))
}

/// `squareEnds` of one path, a leg clear when it crosses none of the given
/// rects.
///
/// In: `[n, then x, y per point, exit, entry, from side, to side, m, then x,
/// y, w, h per rect]`. Out: the squared path as a count and x, y pairs, and
/// an empty array for a malformed input.
#[wasm_bindgen]
#[must_use]
pub fn edge_square_ends(input: &[f64]) -> Vec<f64> {
    let decoded = (|| {
        let (&n, rest) = input.split_first()?;
        let (coords, rest) = rest.split_at_checked(count(n)?.checked_mul(2)?)?;
        let (head, rest) = rest.split_first_chunk::<6>()?;
        let obstacles = rects_then(rest)?;
        Some((coords.chunks_exact(2).map(point).collect::<Vec<_>>(), *head, obstacles))
    })();
    let Some((path, [ex, ey, nx, ny, from, to], obstacles)) = decoded else { return Vec::new() };
    let clear = |a: Point, b: Point| obstacles.iter().all(|&r| !segment_crosses_rect(a, b, r));
    let ends = SquareEnds {
        exit: Point { x: ex, y: ey },
        entry: Point { x: nx, y: ny },
        from_side: side(from),
        to_side: side(to),
        clear: &clear,
    };
    points_out(Some(square_ends(path, &ends)))
}

/// `initialSideChoices` over one canvas.
///
/// In: the routing wire's nodes then edges (`crate::routing_wire`). Out: the
/// choice count, then per entry in the map's iteration order its edge id and
/// its from and to side index. A malformed input answers an empty array.
#[wasm_bindgen]
#[must_use]
pub fn edge_initial_sides(input: &[f64]) -> Vec<f64> {
    let mut wire = Wire::new(input);
    let (Some(nodes), Some(edges)) = (wire.nodes(), wire.edges()) else { return Vec::new() };
    if !wire.is_done() {
        return Vec::new();
    }
    let choices = initial_side_choices(&nodes, &edges);
    let mut out = vec![points_len_of(choices.len())];
    for (id, pair) in choices.iter() {
        out.extend([f64::from(*id), side_index(pair.from_side), side_index(pair.to_side)]);
    }
    out
}

/// `marksContact` and the contact itself per edge.
///
/// In: the routing wire's nodes then edges. Out: 8 numbers an edge,
/// `[marksContact 0/1, a contact 0/1, its tail x, y and tip x, y, its from
/// and to side index]`, NaN and `-1` where there is no contact (both ends'
/// rects read as `rectAtEnd` does).
#[wasm_bindgen]
#[must_use]
pub fn edge_contacts(input: &[f64]) -> Vec<f64> {
    let mut wire = Wire::new(input);
    let (Some(nodes), Some(edges)) = (wire.nodes(), wire.edges()) else { return Vec::new() };
    if !wire.is_done() {
        return Vec::new();
    }
    edges
        .iter()
        .flat_map(|edge| {
            let rects = rect_at_end(&nodes, &edge.from).zip(rect_at_end(&nodes, &edge.to));
            let contact = rects.and_then(|(from, to)| contact_for(edge, from, to));
            let [tail, tip] = contact.map_or([Point { x: f64::NAN, y: f64::NAN }; 2], |c| c.path);
            [
                if marks_contact(&nodes, edge) { 1.0 } else { 0.0 },
                if contact.is_some() { 1.0 } else { 0.0 },
                tail.x,
                tail.y,
                tip.x,
                tip.y,
                contact.map_or(-1.0, |c| side_index(c.from_side)),
                contact.map_or(-1.0, |c| side_index(c.to_side)),
            ]
        })
        .collect()
}

/// `bendRoute` per edge.
///
/// In: the routing wire's nodes then edges, then 8 numbers an edge for its
/// `BendRouteEnds`: `[from anchor set 0/1, x, y, to anchor set 0/1, x, y,
/// from side index or -1, to side index or -1]`. Out per edge: `-2` when an
/// end's rect is missing, else the route as a count and x, y pairs, `-1` for
/// none.
#[wasm_bindgen]
#[must_use]
pub fn edge_bend_routes(input: &[f64]) -> Vec<f64> {
    let mut wire = Wire::new(input);
    let (Some(nodes), Some(edges)) = (wire.nodes(), wire.edges()) else { return Vec::new() };
    let ends = wire.rest();
    if ends.len() != edges.len().saturating_mul(8) {
        return Vec::new();
    }
    let anchor = |set: f64, x: f64, y: f64| (set != 0.0).then_some(Point { x, y });
    edges
        .iter()
        .zip(ends.chunks_exact(8))
        .flat_map(|(edge, e)| {
            let [fs, fx, fy, ts, tx, ty, fside, tside] = *e else { return vec![-1.0] };
            let route_ends = BendRouteEnds {
                from: anchor(fs, fx, fy),
                to: anchor(ts, tx, ty),
                from_side: side_of(fside),
                to_side: side_of(tside),
            };
            match rect_at_end(&nodes, &edge.from).zip(rect_at_end(&nodes, &edge.to)) {
                None => vec![-2.0],
                Some((from, to)) => points_out(bend_route(edge, from, to, &route_ends)),
            }
        })
        .collect()
}

/// `selfEdgeLoopControlPoints` per case: in `[x, y, side index]`, out the
/// two points' x, y.
#[wasm_bindgen]
#[must_use]
pub fn edge_self_loop_points(cases: &[f64]) -> Vec<f64> {
    cases
        .chunks_exact(3)
        .flat_map(|c| {
            let [x, y, index] = *c else { return [f64::NAN; 4] };
            let [first, second] = self_edge_loop_control_points(Point { x, y }, side(index));
            [first.x, first.y, second.x, second.y]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{edge_corner_detour, edge_side_slides, edge_square_ends, edge_zero_bend_slide};

    #[test]
    fn the_leaf_exports_answer_their_declared_shapes() {
        let mut slides = vec![100.0, 20.0, 200.0, 40.0, 1.0, 3.0, 0.0, 0.0, 100.0, 60.0];
        slides.extend([200.0, 0.0, 100.0, 60.0, -1.0, 0.0, 20.0, 0.0, 30.0]);
        assert_eq!(edge_side_slides(&slides).len(), 11);
        let mut zero = slides.get(..14).unwrap_or_default().to_vec();
        zero.push(0.0);
        assert_eq!(edge_zero_bend_slide(&zero), vec![2.0, 100.0, 20.0, 200.0, 20.0]);
        assert_eq!(
            edge_corner_detour(&[0.0, 0.0, 100.0, 0.0, 8.0, 0.0]),
            vec![2.0, 0.0, 0.0, 100.0, 0.0]
        );
        assert!(edge_square_ends(&[1.0]).is_empty());
    }
}
