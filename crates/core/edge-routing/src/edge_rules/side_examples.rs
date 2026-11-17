//! The side preference rules one at a time, each on the arrangement that
//! decides it. `compose_side_pairs` merges the rules, so a pair a later rule
//! also proposes hides which rule ranked it; these examples read each rule
//! alone. The inputs and answers are the TypeScript edge rules' examples,
//! which recorded what each rule returned before the router moved here.

#![expect(clippy::float_cmp, reason = "every value here is an exact integer")]

use super::{
    End, LaneAxis, PreferenceContext, SLIDE_CORNER_INSET_PX, ZERO_LANE_MIN_OVERLAP_PX,
    dominant_axis_order, facing_lane_window, gap_valid_opposing_before_invalid,
    l_pair_crowding_tie_break, less_cost, u_hook_span_exposed_first, u_hook_when_degenerate,
    zero_bend_facing_first,
};
use crate::edge_geometry::Side::{self, Bottom as B, Left as L, Right as R, Top as T};
use crate::edge_rules::{Cost, SidePair};
use crate::geometry::Rect;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_proptest::proptest::prelude::{Strategy, prop_assert};
use whiteboard_proptest::{Floor, check};

type Rule = fn(&PreferenceContext<'_>) -> Vec<SidePair>;

const fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

/// A 100-square at `(x, y)`, as the TypeScript's `rectAt`.
const fn sq(x: f64, y: f64) -> Rect {
    r(x, y, 100.0, 100.0)
}

fn with_crowd(
    rule: Rule,
    (dx, dy): (f64, f64),
    from_rect: Rect,
    to_rect: Rect,
    crowd: &dyn Fn(End, Side) -> f64,
) -> Vec<(Side, Side)> {
    let ctx = PreferenceContext { dx, dy, from_rect, to_rect, crowd };
    rule(&ctx).into_iter().map(|p| (p.from_side, p.to_side)).collect()
}

fn ranked(rule: Rule, offset: (f64, f64), from_rect: Rect, to_rect: Rect) -> Vec<(Side, Side)> {
    with_crowd(rule, offset, from_rect, to_rect, &|_, _| 0.0)
}

/// The offset between the two rects' centres, which is what a caller passes.
fn centre_offset(from: Rect, to: Rect) -> (f64, f64) {
    (to.x + to.w / 2.0 - (from.x + from.w / 2.0), to.y + to.h / 2.0 - (from.y + from.h / 2.0))
}

// zero-bend-facing-first

/// The shared lane is exactly the 20px minimum: spans [10, 90] and [70, 150].
#[test]
fn zero_bend_ranks_the_opposing_pair_on_a_lane_of_exactly_the_minimum() {
    assert_eq!(
        ranked(zero_bend_facing_first, (200.0, 60.0), sq(0.0, 0.0), sq(200.0, 60.0)),
        [(R, L)]
    );
}

#[test]
fn zero_bend_excludes_the_pair_when_the_facing_lane_is_one_pixel_short() {
    assert_eq!(ranked(zero_bend_facing_first, (200.0, 61.0), sq(0.0, 0.0), sq(200.0, 61.0)), []);
    assert_eq!(ZERO_LANE_MIN_OVERLAP_PX, 20.0);
}

/// Each facing-gap comparison is inclusive: boxes touching edge to edge face
/// each other, and one pixel of interpenetration takes the pair away.
#[test]
fn zero_bend_counts_boxes_touching_edge_to_edge_as_facing_in_all_four_directions() {
    let rows = [
        (sq(0.0, 0.0), sq(100.0, 0.0), sq(99.0, 0.0), (R, L)),
        (sq(100.0, 0.0), sq(0.0, 0.0), sq(1.0, 0.0), (L, R)),
        (sq(0.0, 0.0), sq(0.0, 100.0), sq(0.0, 99.0), (B, T)),
        (sq(0.0, 100.0), sq(0.0, 0.0), sq(0.0, 1.0), (T, B)),
    ];
    for (from, touching, overlapping, expected) in rows {
        let touching_pairs =
            ranked(zero_bend_facing_first, centre_offset(from, touching), from, touching);
        assert_eq!(touching_pairs, [expected], "touching {touching:?}");
        let overlapping_pairs =
            ranked(zero_bend_facing_first, centre_offset(from, overlapping), from, overlapping);
        assert_eq!(overlapping_pairs, [], "overlapping {overlapping:?}");
    }
}

/// A horizontal zero-bend needs an x-gap and a vertical one an x-overlap, so
/// at most one pair qualifies. It does not follow that the one that does is
/// on the dominant axis: see the next example.
#[test]
fn zero_bend_offers_at_most_one_pair() {
    let box_at = (-300i32..=300, -300i32..=300, 1i32..=200, 1i32..=200)
        .prop_map(|(x, y, w, h)| r(f64::from(x), f64::from(y), f64::from(w), f64::from(h)));
    let one = Floor::new("an arrangement with a zero-bend pair");
    check((box_at.clone(), box_at), Some(300), |(from, to)| {
        let ranked = ranked(zero_bend_facing_first, centre_offset(from, to), from, to);
        one.draw(ranked.len() == 1);
        prop_assert!(ranked.len() <= 1, "{ranked:?}");
        Ok(())
    });
    // Measured 55 to 75 of 300.
    one.assert(30);
}

/// |dx| 40 > |dy| 30, yet only the vertical facing is a lane: the boxes
/// overlap in x and are apart in y with 140px of shared x span.
#[test]
fn zero_bend_offers_the_non_dominant_pair_when_only_its_facing_qualifies() {
    let from = r(0.0, 0.0, 200.0, 20.0);
    let to = r(40.0, 30.0, 200.0, 20.0);
    assert_eq!(ranked(zero_bend_facing_first, (40.0, 30.0), from, to), [(B, T)]);
}

#[test]
fn zero_bend_excludes_an_interpenetrating_pair_even_with_ample_span_overlap() {
    assert_eq!(ranked(zero_bend_facing_first, (50.0, 0.0), sq(0.0, 0.0), sq(50.0, 0.0)), []);
}

// dominant-axis-first

#[test]
fn dominant_axis_orders_the_larger_offset_first_and_ties_go_horizontal() {
    assert_eq!(dominant_axis_order(10.0, 1.0, 'H', 'V'), ['H', 'V']);
    assert_eq!(dominant_axis_order(1.0, 10.0, 'H', 'V'), ['V', 'H']);
    assert_eq!(dominant_axis_order(5.0, 5.0, 'H', 'V'), ['H', 'V']);
    assert_eq!(dominant_axis_order(-5.0, 5.0, 'H', 'V'), ['H', 'V']);
    assert_eq!(dominant_axis_order(0.0, 0.0, 'H', 'V'), ['H', 'V']);
}

// l-pair-crowding-tie-break

#[test]
fn l_pair_offers_nothing_for_a_purely_axis_aligned_offset() {
    assert_eq!(ranked(l_pair_crowding_tie_break, (100.0, 0.0), sq(0.0, 0.0), sq(200.0, 0.0)), []);
}

#[test]
fn l_pair_keeps_the_dominant_axis_order_when_crowding_ties() {
    assert_eq!(
        ranked(l_pair_crowding_tie_break, (100.0, 50.0), sq(0.0, 0.0), sq(200.0, 150.0)),
        [(R, T), (B, L)]
    );
}

#[test]
fn l_pair_prefers_the_less_crowded_pair_over_the_dominant_axis_default() {
    let crowd = |end: End, side: Side| if end == End::From && side == R { 10.0 } else { 0.0 };
    assert_eq!(
        with_crowd(
            l_pair_crowding_tie_break,
            (100.0, 50.0),
            sq(0.0, 0.0),
            sq(200.0, 150.0),
            &crowd
        ),
        [(B, L), (R, T)]
    );
}

// u-hook-when-degenerate

/// dy = 0 keeps the L pairs out and the x-overlap invalidates both gaps.
#[test]
fn u_hook_offers_same_side_hooks_when_nothing_else_qualifies() {
    assert_eq!(
        ranked(u_hook_when_degenerate, (50.0, 0.0), sq(0.0, 0.0), sq(50.0, 0.0)),
        [(T, T), (B, B)]
    );
}

#[test]
fn u_hook_hooks_over_the_dominant_axis_when_the_offset_is_purely_vertical() {
    assert_eq!(
        ranked(u_hook_when_degenerate, (0.0, 50.0), sq(0.0, 0.0), sq(0.0, 50.0)),
        [(R, R), (L, L)]
    );
}

#[test]
fn u_hook_treats_an_exactly_concentric_pair_as_horizontally_dominant() {
    assert_eq!(
        ranked(u_hook_when_degenerate, (0.0, 0.0), sq(0.0, 0.0), sq(0.0, 0.0)),
        [(T, T), (B, B)]
    );
}

#[test]
fn u_hook_yields_nothing_once_a_zero_bend_alternative_exists() {
    assert_eq!(ranked(u_hook_when_degenerate, (200.0, 60.0), sq(0.0, 0.0), sq(200.0, 60.0)), []);
}

// gap-valid-opposing-before-invalid

/// h is dominant (10 > 5) but its gap is invalid, so the vertical pair leads.
#[test]
fn gap_valid_opposing_pair_leads_even_off_the_dominant_axis() {
    let from = r(0.0, 0.0, 100.0, 50.0);
    let to = r(50.0, 100.0, 100.0, 50.0);
    assert_eq!(ranked(gap_valid_opposing_before_invalid, (10.0, 5.0), from, to), [(B, T), (R, L)]);
}

#[test]
fn gap_valid_opposing_keeps_the_dominant_axis_order_when_both_gaps_are_valid() {
    assert_eq!(
        ranked(gap_valid_opposing_before_invalid, (150.0, 100.0), sq(0.0, 0.0), sq(200.0, 200.0)),
        [(R, L), (B, T)]
    );
}

#[test]
fn gap_valid_opposing_always_offers_both_opposing_pairs() {
    let pairs = ranked(gap_valid_opposing_before_invalid, (50.0, 0.0), sq(0.0, 0.0), sq(50.0, 0.0));
    assert_eq!(pairs.len(), 2);
    assert!(pairs.contains(&(R, L)) && pairs.contains(&(B, T)), "{pairs:?}");
}

// incumbent-wins-ties: the search adopts a candidate only on `less_cost`.

#[test]
fn incumbent_wins_ties_a_candidate_is_adopted_only_when_strictly_cheaper() {
    let cost = |c: f64| -> Cost { [c, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] };
    assert!(!less_cost(&cost(5.0), &cost(5.0)));
    assert!(less_cost(&cost(4.0), &cost(5.0)));
    assert!(!less_cost(&cost(6.0), &cost(5.0)));
}

// facing_lane_window

/// y spans [10, 90] and [50, 130] share [50, 90].
#[test]
fn facing_lane_window_insets_both_ends_then_intersects_the_spans() {
    assert_eq!(facing_lane_window(sq(0.0, 0.0), sq(200.0, 40.0), LaneAxis::H), Some((50.0, 90.0)));
    assert_eq!(SLIDE_CORNER_INSET_PX, 10.0);
}

#[test]
fn facing_lane_window_reads_the_x_spans_on_the_vertical_axis() {
    assert_eq!(facing_lane_window(sq(0.0, 0.0), sq(40.0, 200.0), LaneAxis::V), Some((50.0, 90.0)));
}

#[test]
fn facing_lane_window_qualifies_exactly_the_minimum_and_rejects_the_pixel_below() {
    assert_eq!(facing_lane_window(sq(0.0, 0.0), sq(200.0, 60.0), LaneAxis::H), Some((70.0, 90.0)));
    assert_eq!(facing_lane_window(sq(0.0, 0.0), sq(200.0, 61.0), LaneAxis::H), None);
}

/// A 12px side inset by 10 at both ends would run backwards; the clamp
/// collapses it to its midpoint, which hosts no lane. Without the clamp the
/// answer is the same: the window is never wider than this side's span, and
/// an inverted span is narrower than zero. So this pins the answer, not the
/// clamp, which no window can show (mutation-checked: removing it stays green).
#[test]
fn facing_lane_window_opens_no_lane_on_a_side_shorter_than_twice_the_inset() {
    assert_eq!(facing_lane_window(r(0.0, 0.0, 100.0, 12.0), sq(200.0, 0.0), LaneAxis::H), None);
}

// u-hook-span-exposed-first

/// Each target taints exactly one of the 100-square's borders.
#[test]
fn u_hook_span_demotes_the_one_hook_whose_border_enters_the_target() {
    let rows = [
        (r(20.0, -50.0, 60.0, 60.0), [R, B, L, T]),
        (r(20.0, 90.0, 60.0, 60.0), [T, R, L, B]),
        (r(-50.0, 20.0, 60.0, 60.0), [T, R, B, L]),
        (r(90.0, 20.0, 60.0, 60.0), [T, B, L, R]),
    ];
    for (to, order) in rows {
        let ranked =
            ranked(u_hook_span_exposed_first, centre_offset(sq(0.0, 0.0), to), sq(0.0, 0.0), to);
        assert_eq!(ranked.iter().map(|p| p.0).collect::<Vec<_>>(), order, "{to:?}");
        assert!(ranked.iter().all(|(from, to)| from == to), "{ranked:?}");
    }
}

#[test]
fn u_hook_span_always_offers_all_four_same_side_hooks() {
    let pairs = ranked(u_hook_span_exposed_first, (200.0, 200.0), sq(0.0, 0.0), sq(200.0, 200.0));
    assert_eq!(pairs.len(), 4);
    for side in [T, R, B, L] {
        assert!(pairs.contains(&(side, side)), "{pairs:?}");
    }
}

/// The top border (y = 570, x 100..300) runs through the target's interior
/// for x in (220, 300); the bottom (y = 670) misses its y range.
#[test]
fn u_hook_span_demotes_a_side_running_through_the_target_on_the_reported_canvas() {
    let from = r(100.0, 570.0, 200.0, 100.0);
    let to = r(220.0, 520.0, 200.0, 100.0);
    let pairs = ranked(u_hook_span_exposed_first, (120.0, -50.0), from, to);
    let at = |side: Side| pairs.iter().position(|p| p.0 == side);
    assert!(at(B) < at(T), "{pairs:?}");
}

#[test]
fn u_hook_span_demotes_nothing_when_the_other_end_contains_this_one() {
    let from = r(10.0, 10.0, 20.0, 20.0);
    let to = r(0.0, 0.0, 200.0, 200.0);
    assert_eq!(
        ranked(u_hook_span_exposed_first, (0.0, 0.0), from, to),
        [(T, T), (R, R), (B, B), (L, L)]
    );
}

#[test]
fn u_hook_span_keeps_compass_order_among_equally_clean_sides() {
    assert_eq!(
        ranked(u_hook_span_exposed_first, (400.0, 400.0), sq(0.0, 0.0), sq(400.0, 400.0)),
        [(T, T), (R, R), (B, B), (L, L)]
    );
}
