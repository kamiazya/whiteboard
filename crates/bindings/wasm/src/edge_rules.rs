//! The edge layer's named rules over flat arrays, for the property
//! differential that holds them to canvas-render's `edge-rules.ts`
//! (ADR-0054 step 5, QR-21 layer 2). Batched, a test surface like
//! [`crate::edge_primitives`]: a layout will call the edge layer once, not
//! these.
//!
//! A side travels as its index in `edgeSideSchema.options` order (top,
//! right, bottom, left).

use crate::edge_primitives::{count, point, rect};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::{
    Cost, End, LaneAxis, PreferenceContext, SIDES, TIERS, add_cost, compose_side_pairs,
    facing_lane_window, has_repairable_problem, less_cost, self_penalty,
};
use whiteboard_edge_routing::geometry::{Point, Rect};

fn side_index(side: Side) -> f64 {
    match side {
        Side::Top => 0.0,
        Side::Right => 1.0,
        Side::Bottom => 2.0,
        Side::Left => 3.0,
    }
}

/// The ranked side pairs per case.
///
/// In: 18 numbers a case, `[dx, dy, from rect x y w h, to rect x y w h, then
/// the crowd at the from end's top, right, bottom, left sides and at the to
/// end's]`. Out per case: the pair count, then each pair's from and to side
/// index. A trailing partial case is ignored.
#[cfg_attr(feature = "oracle-surface", wasm_bindgen::prelude::wasm_bindgen)]
#[must_use]
pub fn edge_side_pairs(cases: &[f64]) -> Vec<f64> {
    let mut out = Vec::new();
    for c in cases.chunks_exact(18) {
        let [dx, dy, ..] = *c else { continue };
        let crowds = c.get(10..18).unwrap_or(&[]);
        let crowd = |end: End, side: Side| {
            let offset = if end == End::From { 0 } else { 4 };
            let at = SIDES.iter().position(|&s| s == side).unwrap_or(0);
            crowds.get(offset + at).copied().unwrap_or(f64::NAN)
        };
        let ctx = PreferenceContext {
            dx,
            dy,
            from_rect: rect(c.get(2..).unwrap_or(&[])),
            to_rect: rect(c.get(6..).unwrap_or(&[])),
            crowd: &crowd,
        };
        let ranked = compose_side_pairs(&ctx);
        out.push(crate::edge_primitives::points_len_of(ranked.len()));
        out.extend(ranked.iter().flat_map(|p| [side_index(p.from_side), side_index(p.to_side)]));
    }
    out
}

/// `facingLaneWindow` per case, both axes.
///
/// In: 8 numbers a case, `[from rect, to rect]`. Out: 4 a case, the `h`
/// window's lo and hi then the `v` window's, NaN NaN for none.
#[cfg_attr(feature = "oracle-surface", wasm_bindgen::prelude::wasm_bindgen)]
#[must_use]
pub fn edge_lane_windows(cases: &[f64]) -> Vec<f64> {
    cases
        .chunks_exact(8)
        .flat_map(|c| {
            let (from, to) = (rect(c), rect(c.get(4..).unwrap_or(&[])));
            let window = |axis| facing_lane_window(from, to, axis).unwrap_or((f64::NAN, f64::NAN));
            let (h, v) = (window(LaneAxis::H), window(LaneAxis::V));
            [h.0, h.1, v.0, v.1]
        })
        .collect()
}

fn rects_at(values: &[f64]) -> Option<(Vec<Rect>, &[f64])> {
    let (&m, rest) = values.split_first()?;
    let (body, rest) = rest.split_at_checked(count(m)?.checked_mul(4)?)?;
    Some((body.chunks_exact(4).map(rect).collect(), rest))
}

/// `selfPenalty` of one path.
///
/// In: `[n, then x, y per point, then the foreign bodies, the node borders
/// and the endpoint rects, each as a count and x, y, w, h per rect]`. Out:
/// the seven-tier cost. A malformed input answers an empty array.
#[cfg_attr(feature = "oracle-surface", wasm_bindgen::prelude::wasm_bindgen)]
#[must_use]
pub fn edge_self_penalty(input: &[f64]) -> Vec<f64> {
    let decoded = (|| {
        let (&n, rest) = input.split_first()?;
        let (coords, rest) = rest.split_at_checked(count(n)?.checked_mul(2)?)?;
        let path: Vec<Point> = coords.chunks_exact(2).map(point).collect();
        let (foreign, rest) = rects_at(rest)?;
        let (borders, rest) = rects_at(rest)?;
        let (endpoints, rest) = rects_at(rest)?;
        rest.is_empty().then_some((path, foreign, borders, endpoints))
    })();
    let Some((path, foreign, borders, endpoints)) = decoded else { return Vec::new() };
    self_penalty(&path, &foreign, &borders, &endpoints).to_vec()
}

fn cost(values: &[f64]) -> Cost {
    let mut out = [f64::NAN; TIERS];
    for (o, v) in out.iter_mut().zip(values) {
        *o = *v;
    }
    out
}

/// The cost operations per case.
///
/// In: 15 numbers a case, `[a's seven tiers, b's seven, sign]`. Out: 10 a
/// case, `[lessCost(a, b), lessCost(b, a), hasRepairableProblem(a) as 0/1,
/// then addCost(a, b, sign)'s seven]`.
#[cfg_attr(feature = "oracle-surface", wasm_bindgen::prelude::wasm_bindgen)]
#[must_use]
pub fn edge_cost_ops(cases: &[f64]) -> Vec<f64> {
    let flag = |b: bool| if b { 1.0 } else { 0.0 };
    cases
        .chunks_exact(2 * TIERS + 1)
        .flat_map(|c| {
            let (a, b) = (cost(c), cost(c.get(TIERS..).unwrap_or(&[])));
            let sign = c.get(2 * TIERS).copied().unwrap_or(f64::NAN);
            let mut out = vec![
                flag(less_cost(&a, &b)),
                flag(less_cost(&b, &a)),
                flag(has_repairable_problem(&a)),
            ];
            out.extend(add_cost(&a, &b, sign));
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{edge_cost_ops, edge_lane_windows, edge_self_penalty, edge_side_pairs};

    #[test]
    fn facing_boxes_rank_right_to_left_first() {
        let mut case = vec![200.0, 0.0, 0.0, 0.0, 100.0, 60.0, 200.0, 0.0, 100.0, 60.0];
        case.extend([0.0; 8]);
        let out = edge_side_pairs(&case);
        assert_eq!(out.get(1..3), Some(&[1.0, 3.0][..]));
        assert_eq!(
            edge_lane_windows(&[0.0, 0.0, 100.0, 60.0, 200.0, 0.0, 100.0, 60.0]).first(),
            Some(&10.0)
        );
    }

    #[test]
    fn the_penalty_and_cost_exports_answer_seven_tiers() {
        let penalty = edge_self_penalty(&[3.0, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 0.0, 0.0]);
        assert_eq!(penalty.len(), 7);
        assert_eq!(penalty.last(), Some(&1.0));
        assert!(edge_self_penalty(&[3.0, 0.0]).is_empty());
        let mut case = vec![0.0; 15];
        case[7] = 1.0;
        case[14] = 1.0;
        assert_eq!(edge_cost_ops(&case).get(..4), Some(&[1.0, 0.0, 0.0, 1.0][..]));
    }
}
