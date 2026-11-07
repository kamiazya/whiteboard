//! The named rules side choice and routing are judged by: canvas-render's
//! `layout/edges/edge-rules.ts`, ported rule for rule.
//!
//! The reasoning behind each rule is written once, in the TypeScript. Two
//! things differ in shape, not in answer:
//!
//! - The TypeScript takes a rule list as a parameter that every production
//!   caller leaves at its default. Here the lists ARE the defaults: the side
//!   preference rules run in [`compose_side_pairs`]'s fixed order, and a cost
//!   is a [`Cost`] indexed by the seven penalty tiers.
//! - `Math.sign` is [`js_sign`], so a NaN or a signed zero reaches the same
//!   comparisons the TypeScript makes; `bendCount`'s direction string, in
//!   which `NaN` equals `NaN`, is a [`SignClass`] pair.

#![expect(clippy::float_cmp, reason = "the TypeScript compares with ===")]

use crate::edge_geometry::Side;
use crate::edge_ink::{
    diagonal_ink_through, ink_along_rects, on_either_border, quantize, self_retraced_ink,
    strictly_between, tunnelled_ink,
};
use crate::geometry::{Point, Rect};
use core::cmp::Ordering;
use whiteboard_det::math::{compare_numbers, js_max, js_min, js_sign};

/// A departure and arrival side, as `SidePair`; `around` marks a pair the
/// around ledger proposed, which no rule here sets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SidePair {
    pub from_side: Side,
    pub to_side: Side,
    pub around: bool,
}

const fn pair(from_side: Side, to_side: Side) -> SidePair {
    SidePair { from_side, to_side, around: false }
}

/// The model's `edgeSideSchema.options`, in its order.
pub const SIDES: [Side; 4] = [Side::Top, Side::Right, Side::Bottom, Side::Left];

#[must_use]
pub const fn opposite_side(side: Side) -> Side {
    match side {
        Side::Top => Side::Bottom,
        Side::Bottom => Side::Top,
        Side::Left => Side::Right,
        Side::Right => Side::Left,
    }
}

/// As `ZERO_LANE_MIN_OVERLAP_PX`.
pub const ZERO_LANE_MIN_OVERLAP_PX: f64 = 20.0;

/// As `SLIDE_CORNER_INSET_PX`.
pub const SLIDE_CORNER_INSET_PX: f64 = 10.0;

/// `'h'` or `'v'`: the axis a facing pair of sides runs along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneAxis {
    H,
    V,
}

/// The window two facing sides share, inset from each side's corners, or
/// `None` when it is narrower than the zero-bend minimum.
#[must_use]
pub fn facing_lane_window(from_rect: Rect, to_rect: Rect, axis: LaneAxis) -> Option<(f64, f64)> {
    let span = |r: Rect| match axis {
        LaneAxis::H => (
            r.y + js_min(SLIDE_CORNER_INSET_PX, r.h / 2.0),
            r.y + r.h - js_min(SLIDE_CORNER_INSET_PX, r.h / 2.0),
        ),
        LaneAxis::V => (
            r.x + js_min(SLIDE_CORNER_INSET_PX, r.w / 2.0),
            r.x + r.w - js_min(SLIDE_CORNER_INSET_PX, r.w / 2.0),
        ),
    };
    let (a_lo, a_hi) = span(from_rect);
    let (b_lo, b_hi) = span(to_rect);
    let lo = js_max(a_lo, b_lo);
    let hi = js_min(a_hi, b_hi);
    (hi - lo >= ZERO_LANE_MIN_OVERLAP_PX).then_some((lo, hi))
}

/// Which end of an edge a crowding count is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    From,
    To,
}

/// What the side preference rules read, as `PreferenceRuleContext`.
pub struct PreferenceContext<'a> {
    pub dx: f64,
    pub dy: f64,
    pub from_rect: Rect,
    pub to_rect: Rect,
    pub crowd: &'a dyn Fn(End, Side) -> f64,
}

/// The horizontal choice first when `|dx| >= |dy|`.
#[must_use]
pub fn dominant_axis_order<T>(dx: f64, dy: f64, horizontal_first: T, vertical_first: T) -> [T; 2] {
    if dx.abs() >= dy.abs() {
        [horizontal_first, vertical_first]
    } else {
        [vertical_first, horizontal_first]
    }
}

fn hv_sides(dx: f64, dy: f64) -> (Side, Side) {
    (
        if dx >= 0.0 { Side::Right } else { Side::Left },
        if dy >= 0.0 { Side::Bottom } else { Side::Top },
    )
}

fn facing_gap_ok(ctx: &PreferenceContext<'_>, axis: LaneAxis) -> bool {
    let (h, v) = hv_sides(ctx.dx, ctx.dy);
    let (from, to) = (ctx.from_rect, ctx.to_rect);
    match axis {
        LaneAxis::H if h == Side::Right => from.x + from.w <= to.x,
        LaneAxis::H => to.x + to.w <= from.x,
        LaneAxis::V if v == Side::Bottom => from.y + from.h <= to.y,
        LaneAxis::V => to.y + to.h <= from.y,
    }
}

fn zero_bend_facing_first(ctx: &PreferenceContext<'_>) -> Vec<SidePair> {
    let (h, v) = hv_sides(ctx.dx, ctx.dy);
    let zero_h = facing_gap_ok(ctx, LaneAxis::H)
        && facing_lane_window(ctx.from_rect, ctx.to_rect, LaneAxis::H).is_some();
    let zero_v = facing_gap_ok(ctx, LaneAxis::V)
        && facing_lane_window(ctx.from_rect, ctx.to_rect, LaneAxis::V).is_some();
    let pairs =
        dominant_axis_order(ctx.dx, ctx.dy, pair(h, opposite_side(h)), pair(v, opposite_side(v)));
    let oks = dominant_axis_order(ctx.dx, ctx.dy, zero_h, zero_v);
    pairs.into_iter().zip(oks).filter_map(|(p, ok)| ok.then_some(p)).collect()
}

fn l_pair_crowding_tie_break(ctx: &PreferenceContext<'_>) -> Vec<SidePair> {
    if ctx.dx == 0.0 || ctx.dy == 0.0 {
        return Vec::new();
    }
    let (h, v) = hv_sides(ctx.dx, ctx.dy);
    let crowding =
        |p: SidePair| (ctx.crowd)(End::From, p.from_side) + (ctx.crowd)(End::To, p.to_side);
    let mut ordered =
        dominant_axis_order(ctx.dx, ctx.dy, pair(h, opposite_side(v)), pair(v, opposite_side(h)));
    // `[first, second].sort(...)`: stable, so equal crowding keeps the order.
    ordered.sort_by(|a, b| compare_numbers(crowding(*a), crowding(*b)));
    ordered.to_vec()
}

fn u_hook_when_degenerate(ctx: &PreferenceContext<'_>) -> Vec<SidePair> {
    let any_gap_valid = facing_gap_ok(ctx, LaneAxis::H) || facing_gap_ok(ctx, LaneAxis::V);
    if !zero_bend_facing_first(ctx).is_empty()
        || !l_pair_crowding_tie_break(ctx).is_empty()
        || any_gap_valid
    {
        return Vec::new();
    }
    let across = if ctx.dy == 0.0 { Side::Top } else { Side::Right };
    vec![pair(across, across), pair(opposite_side(across), opposite_side(across))]
}

fn gap_valid_opposing_before_invalid(ctx: &PreferenceContext<'_>) -> Vec<SidePair> {
    let (h, v) = hv_sides(ctx.dx, ctx.dy);
    let ordered =
        dominant_axis_order(ctx.dx, ctx.dy, pair(h, opposite_side(h)), pair(v, opposite_side(v)));
    let gap_ok =
        |p: &SidePair| facing_gap_ok(ctx, if p.from_side == h { LaneAxis::H } else { LaneAxis::V });
    let (valid, invalid): (Vec<SidePair>, Vec<SidePair>) = ordered.into_iter().partition(gap_ok);
    valid.into_iter().chain(invalid).collect()
}

/// `rect`'s `side` border as a segment, as `sideSegment`.
fn side_segment(rect: Rect, side: Side) -> [Point; 2] {
    let (left, top, right, bottom) = (rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    match side {
        Side::Top => [Point { x: left, y: top }, Point { x: right, y: top }],
        Side::Bottom => [Point { x: left, y: bottom }, Point { x: right, y: bottom }],
        Side::Left => [Point { x: left, y: top }, Point { x: left, y: bottom }],
        Side::Right => [Point { x: right, y: top }, Point { x: right, y: bottom }],
    }
}

fn side_span_enters_rect(rect: Rect, side: Side, other: Rect) -> bool {
    ink_along_rects(&side_segment(rect, side), &[other], strictly_between) > 0.0
}

fn u_hook_span_exposed_first(ctx: &PreferenceContext<'_>) -> Vec<SidePair> {
    let hooks = SIDES.map(|side| pair(side, side));
    if fully_contains(ctx.to_rect, ctx.from_rect) {
        return hooks.to_vec();
    }
    let (tainted, clean): (Vec<SidePair>, Vec<SidePair>) = hooks
        .into_iter()
        .partition(|p| side_span_enters_rect(ctx.from_rect, p.from_side, ctx.to_rect));
    clean.into_iter().chain(tainted).collect()
}

/// The ranked candidate side pairs, as `composeSidePairs` over
/// `SIDE_PREFERENCE_RULES`: each candidate rule in order, a pair already
/// ranked skipped. The two tiebreak rules generate nothing.
#[must_use]
pub fn compose_side_pairs(ctx: &PreferenceContext<'_>) -> Vec<SidePair> {
    let rules: [fn(&PreferenceContext<'_>) -> Vec<SidePair>; 5] = [
        zero_bend_facing_first,
        l_pair_crowding_tie_break,
        u_hook_when_degenerate,
        gap_valid_opposing_before_invalid,
        u_hook_span_exposed_first,
    ];
    let mut ranked: Vec<SidePair> = Vec::new();
    for rule in rules {
        for candidate in rule(ctx) {
            let key = (candidate.from_side, candidate.to_side);
            if !ranked.iter().any(|r| (r.from_side, r.to_side) == key) {
                ranked.push(candidate);
            }
        }
    }
    ranked
}

/// A sign as `bendCount`'s direction string spells it: `-0` reads `0`, and
/// `NaN` is its own value, equal to itself as a string is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignClass {
    Negative,
    Zero,
    Positive,
    NaN,
}

fn sign_class(x: f64) -> SignClass {
    let s = js_sign(x);
    if s.is_nan() {
        SignClass::NaN
    } else if s > 0.0 {
        SignClass::Positive
    } else if s < 0.0 {
        SignClass::Negative
    } else {
        SignClass::Zero
    }
}

/// How many times the path changes direction, as `bendCount`.
#[must_use]
pub fn bend_count(path: &[Point]) -> f64 {
    let mut bends = 0.0;
    let mut last: Option<(SignClass, SignClass)> = None;
    for pair in path.windows(2) {
        let [a, b] = pair else { continue };
        let dir = (sign_class(b.x - a.x), sign_class(b.y - a.y));
        if dir == (SignClass::Zero, SignClass::Zero) {
            continue;
        }
        if last.is_some_and(|l| l != dir) {
            bends += 1.0;
        }
        last = Some(dir);
    }
    bends
}

/// Border-inclusive containment, as `fullyContains`.
#[must_use]
pub fn fully_contains(outer: Rect, inner: Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w
        && inner.y + inner.h <= outer.y + outer.h
}

/// Quantized ink strictly inside `rects`, a rect that strictly contains
/// another of them left out, as `interiorInkThrough`. The TypeScript's
/// `other !== r` is identity, so the exclusion is by index.
#[must_use]
pub fn interior_ink_through(path: &[Point], rects: &[Rect]) -> f64 {
    let bodies: Vec<Rect> = rects
        .iter()
        .enumerate()
        .filter(|&(i, &r)| {
            !rects
                .iter()
                .enumerate()
                .any(|(j, &other)| j != i && fully_contains(r, other) && !fully_contains(other, r))
        })
        .map(|(_, &r)| r)
        .collect();
    ink_along_rects(path, &bodies, strictly_between)
}

fn quantized_sign(a: f64, b: f64) -> f64 {
    js_sign(quantize(b) - quantize(a))
}

/// How many times the path turns back on either axis, as `reversalCount`.
fn reversal_count(path: &[Point]) -> f64 {
    let mut reversals = 0.0;
    let mut last_x: Option<f64> = None;
    let mut last_y: Option<f64> = None;
    for pair in path.windows(2) {
        let [a, b] = pair else { continue };
        for (s, last) in
            [(quantized_sign(a.x, b.x), &mut last_x), (quantized_sign(a.y, b.y), &mut last_y)]
        {
            if s != 0.0 {
                if last.is_some_and(|l| s == -l) {
                    reversals += 1.0;
                }
                *last = Some(s);
            }
        }
    }
    reversals
}

/// The number of penalty tiers.
pub const TIERS: usize = 7;

/// A cost tuple, one entry per tier, compared lexicographically from tier 0.
pub type Cost = [f64; TIERS];

/// `zeroPenalty()`.
pub const ZERO_COST: Cost = [0.0; TIERS];

/// `pairPenalty`: the three pairwise terms land on tiers 0 to 2.
#[must_use]
pub fn pair_penalty(triple: [f64; 3]) -> Cost {
    let [overlap, illegible, crossings] = triple;
    [overlap, illegible, crossings, 0.0, 0.0, 0.0, 0.0]
}

/// `selfPenalty`, tier by tier as `PENALTY_RULES` assigns them.
#[must_use]
pub fn self_penalty(
    path: &[Point],
    foreign_bodies: &[Rect],
    node_borders: &[Rect],
    endpoint_rects: &[Rect],
) -> Cost {
    [
        quantize(diagonal_ink_through(path, endpoint_rects))
            + tunnelled_ink(path, foreign_bodies)
            + self_retraced_ink(path),
        0.0,
        0.0,
        interior_ink_through(path, endpoint_rects),
        ink_along_rects(path, node_borders, on_either_border),
        reversal_count(path),
        bend_count(path),
    ]
}

/// `addCost(a, b, sign)`.
#[must_use]
pub fn add_cost(a: &Cost, b: &Cost, sign: f64) -> Cost {
    let mut out = ZERO_COST;
    for ((o, x), y) in out.iter_mut().zip(a).zip(b) {
        *o = x + sign * y;
    }
    out
}

/// `accumulateCost(target, b, sign)`.
pub fn accumulate_cost(target: &mut Cost, b: &Cost, sign: f64) {
    for (t, y) in target.iter_mut().zip(b) {
        *t += sign * y;
    }
}

/// `lessCost(a, b)`: the first tier that differs decides.
#[must_use]
pub fn less_cost(a: &Cost, b: &Cost) -> bool {
    a.iter().zip(b).find(|(x, y)| x != y).is_some_and(|(x, y)| x < y)
}

/// `hasRepairableProblem`: a non-zero term on any tier but the last.
#[must_use]
pub fn has_repairable_problem(cost: &Cost) -> bool {
    cost.iter().take(TIERS - 1).any(|&c| c != 0.0)
}

/// `lessCost` as an ordering, for a caller that sorts by cost.
#[must_use]
pub fn cost_order(a: &Cost, b: &Cost) -> Ordering {
    if less_cost(a, b) {
        Ordering::Less
    } else if less_cost(b, a) {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

#[cfg(test)]
mod tests {
    use super::{
        End, PreferenceContext, Side, bend_count, compose_side_pairs, has_repairable_problem,
        less_cost, pair, self_penalty,
    };
    use crate::geometry::{Point, Rect};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    const fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    const fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn facing_boxes_rank_the_zero_bend_pair_first() {
        let no_crowd = |_: End, _: Side| 0.0;
        let ctx = PreferenceContext {
            dx: 200.0,
            dy: 0.0,
            from_rect: r(0.0, 0.0, 100.0, 60.0),
            to_rect: r(200.0, 0.0, 100.0, 60.0),
            crowd: &no_crowd,
        };
        let ranked = compose_side_pairs(&ctx);
        assert_eq!(ranked.first(), Some(&pair(Side::Right, Side::Left)));
        // Every pair is ranked at most once.
        for (k, q) in ranked.iter().enumerate() {
            assert!(
                !ranked
                    .iter()
                    .skip(k + 1)
                    .any(|o| (o.from_side, o.to_side) == (q.from_side, q.to_side))
            );
        }
    }

    #[test]
    fn a_two_bend_path_counts_two_bends_and_a_nan_direction_equals_itself() {
        assert_eq!(bend_count(&[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(20.0, 10.0)]), 2.0);
        assert_eq!(bend_count(&[p(0.0, 0.0), p(f64::NAN, 0.0), p(f64::NAN, 0.0)]), 0.0);
    }

    #[test]
    fn costs_compare_from_the_first_tier_and_the_last_tier_is_not_repairable() {
        let clean = self_penalty(&[p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0)], &[], &[], &[]);
        assert!(!has_repairable_problem(&clean));
        let mut dirty = clean;
        dirty[0] = 4.0;
        assert!(less_cost(&clean, &dirty) && !less_cost(&dirty, &clean));
        assert!(has_repairable_problem(&dirty));
    }
}
