//! The side-preference composition and the penalty tiers as properties:
//! `compose_side_pairs` is total and deterministic on any two-node offset,
//! `pair_penalty` and `self_penalty` put each term on its declared tier as a
//! finite non-negative integer, border-tracing, endpoint-body-ink and
//! path-reversal agree with oracles written from their definitions, the two
//! ink tiers never charge one segment twice, and `has_repairable_problem`
//! reads every tier but the last.
//!
//! The TypeScript twin is `edge-rules.properties.test.ts`. The tier indices
//! are restated here from `PENALTY_RULES`' declaration, since the Rust port
//! has no rule list to look them up in.

#![expect(clippy::float_cmp, reason = "every cost here is an exact integer")]

use whiteboard_det::math::js_round;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_ink::COST_QUANTUM;
use whiteboard_edge_routing::edge_rules::{
    Cost, End, PreferenceContext, SidePair, TIERS, bend_count, compose_side_pairs,
    has_repairable_problem, pair_penalty, self_penalty,
};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_proptest::proptest::prelude::{
    Just, Strategy, any, prop, prop_assert, prop_assert_eq, prop_oneof,
};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const OVERLAP_AND_INTRUSION: usize = 0;
const ENDPOINT_BODY_INK: usize = 3;
const BORDER_TRACING: usize = 4;
const PATH_REVERSAL: usize = 5;
const REALIZED_BENDS: usize = 6;

fn rect(x: i32, y: i32, w: i32, h: i32) -> Rect {
    Rect { x: f64::from(x), y: f64::from(y), w: f64::from(w), h: f64::from(h) }
}

fn pt(x: i32, y: i32) -> Point {
    Point { x: f64::from(x), y: f64::from(y) }
}

fn rect_in(at: i32, size: i32) -> impl Strategy<Value = Rect> {
    (-at..=at, -at..=at, 0..=size, 0..=size).prop_map(|(x, y, w, h)| rect(x, y, w, h))
}

/// What a preference rule reads, minus the crowding closure (always zero).
#[derive(Debug, Clone, Copy)]
struct Ctx {
    dx: f64,
    dy: f64,
    from: Rect,
    to: Rect,
}

fn compose(c: &Ctx) -> Vec<SidePair> {
    let no_crowd = |_: End, _: Side| 0.0;
    compose_side_pairs(&PreferenceContext {
        dx: c.dx,
        dy: c.dy,
        from_rect: c.from,
        to_rect: c.to,
        crowd: &no_crowd,
    })
}

/// An offset drawn independently of the two rects, as `incoherentContextArb`.
fn incoherent_ctx() -> impl Strategy<Value = Ctx> {
    (-300i32..=300, -300i32..=300, rect_in(100, 120), rect_in(100, 120))
        .prop_map(|(dx, dy, from, to)| Ctx { dx: f64::from(dx), dy: f64::from(dy), from, to })
}

/// Zero, then small (interpenetrating at these box sizes), then far.
fn centre_offset() -> impl Strategy<Value = i32> {
    prop_oneof![2 => Just(0), 3 => -60i32..=60, 2 => -300i32..=300]
}

/// The offset IS the two rects' centre delta, as `coherentContextArb`.
fn coherent_ctx() -> impl Strategy<Value = Ctx> {
    (rect_in(100, 120), 0i32..=120, 0i32..=120, centre_offset(), centre_offset()).prop_map(
        |(from, tw, th, dx, dy)| {
            let (tw, th) = (f64::from(tw), f64::from(th));
            let cx = from.x + from.w / 2.0;
            let cy = from.y + from.h / 2.0;
            let to = Rect {
                x: js_round(cx + f64::from(dx) - tw / 2.0),
                y: js_round(cy + f64::from(dy) - th / 2.0),
                w: tw,
                h: th,
            };
            Ctx { dx: to.x + to.w / 2.0 - cx, dy: to.y + to.h / 2.0 - cy, from, to }
        },
    )
}

fn any_ctx() -> impl Strategy<Value = Ctx> {
    prop_oneof![incoherent_ctx(), coherent_ctx()]
}

#[test]
fn compose_side_pairs_never_returns_an_empty_list() {
    check(any_ctx(), None, |c| {
        prop_assert!(!compose(&c).is_empty());
        Ok(())
    });
}

#[test]
fn compose_side_pairs_returns_the_same_ordered_list_twice() {
    check(any_ctx(), None, |c| {
        prop_assert_eq!(compose(&c), compose(&c));
        Ok(())
    });
}

/// A narrow-phase term, zero often enough that an all-zero triple is reachable.
fn term() -> impl Strategy<Value = f64> {
    prop_oneof![1 => Just(0.0), 2 => (0i32..=1000).prop_map(f64::from)]
}

fn triple() -> impl Strategy<Value = [f64; 3]> {
    prop_oneof![
        1 => Just([0.0; 3]),
        5 => (term(), term(), term()).prop_map(|(a, b, c)| [a, b, c]),
    ]
}

#[test]
fn pair_penalty_places_the_triple_on_tiers_zero_to_two_and_nothing_else() {
    check(triple(), None, |t| {
        let [overlap, illegible, crossings] = t;
        prop_assert_eq!(
            pair_penalty(t),
            [overlap, illegible, crossings, 0.0, 0.0, 0.0, 0.0] as Cost
        );
        Ok(())
    });
}

#[test]
fn pair_penalty_is_pure_and_integral() {
    check(triple(), None, |t| {
        prop_assert_eq!(pair_penalty(t), pair_penalty(t));
        prop_assert!(pair_penalty(t).iter().all(|n| is_count(*n)));
        Ok(())
    });
}

fn is_count(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n >= 0.0
}

/// An axis-aligned walk from the origin, as `orthogonalPathArb`.
fn orthogonal_path() -> impl Strategy<Value = Vec<Point>> {
    prop::collection::vec((any::<bool>(), -20i32..=20), 0..=10).prop_map(|moves| {
        let (mut x, mut y) = (0, 0);
        let mut path = vec![pt(x, y)];
        for (horizontal, delta) in moves {
            if horizontal {
                x += delta;
            } else {
                y += delta;
            }
            path.push(pt(x, y));
        }
        path
    })
}

fn free_point() -> impl Strategy<Value = Point> {
    (-200i32..=200, -200i32..=200).prop_map(|(x, y)| pt(x, y))
}

/// Free-form points AND a scaled axis-aligned walk, as `pathArb`.
fn any_path() -> impl Strategy<Value = Vec<Point>> {
    prop_oneof![
        prop::collection::vec(free_point(), 0..=6),
        orthogonal_path().prop_map(|path| {
            path.iter().map(|p| Point { x: p.x * 4.0, y: p.y * 4.0 }).collect()
        }),
    ]
}

fn foreign_bodies() -> impl Strategy<Value = Vec<Rect>> {
    prop::collection::vec(rect_in(200, 200), 0..=4)
}

/// A rect on the walk's lattice, so a segment can run along its border.
fn traced_border() -> impl Strategy<Value = Rect> {
    (-20i32..=20, -20i32..=20, 0i32..=20, 0i32..=20)
        .prop_map(|(x, y, w, h)| rect(x * 4, y * 4, w * 4, h * 4))
}

fn node_borders() -> impl Strategy<Value = Vec<Rect>> {
    prop::collection::vec(prop_oneof![1 => rect_in(200, 200), 2 => traced_border()], 0..=4)
}

type SelfInput = (Vec<Point>, Vec<Rect>, Vec<Rect>, Vec<Rect>);

fn self_input() -> impl Strategy<Value = SelfInput> {
    (any_path(), foreign_bodies(), node_borders(), foreign_bodies())
}

#[test]
fn self_penalty_is_a_pure_tuple_of_counts_with_the_pair_only_tiers_empty() {
    check(self_input(), None, |(path, foreign, borders, ends)| {
        let cost = self_penalty(&path, &foreign, &borders, &ends);
        prop_assert_eq!(cost, self_penalty(&path, &foreign, &borders, &ends));
        prop_assert!(cost.iter().all(|n| is_count(*n)), "{cost:?}");
        // illegibility and crossings are pair-only rules.
        prop_assert!(cost[1] == 0.0 && cost[2] == 0.0, "{cost:?}");
        Ok(())
    });
}

#[test]
fn every_self_tier_has_a_witness_that_makes_it_contribute() {
    let cases: [(usize, SelfInput); 5] = [
        (
            OVERLAP_AND_INTRUSION,
            (vec![pt(0, 20), pt(120, 20)], vec![rect(40, 0, 40, 40)], vec![], vec![]),
        ),
        (
            ENDPOINT_BODY_INK,
            (vec![pt(8, 20), pt(32, 20)], vec![], vec![], vec![rect(0, 0, 40, 40)]),
        ),
        (BORDER_TRACING, (vec![pt(0, 0), pt(40, 0)], vec![], vec![rect(0, 0, 40, 40)], vec![])),
        (PATH_REVERSAL, (vec![pt(0, 0), pt(40, 0), pt(20, 0)], vec![], vec![], vec![])),
        (REALIZED_BENDS, (vec![pt(0, 0), pt(40, 0), pt(40, 40)], vec![], vec![], vec![])),
    ];
    for (tier, (path, foreign, borders, ends)) in cases {
        let cost = self_penalty(&path, &foreign, &borders, &ends);
        assert!(cost[tier] != 0.0, "tier {tier}'s witness scores zero: {cost:?}");
    }
    // The pair-only tiers take their term from the triple.
    let cost = pair_penalty([1.0, 1.0, 1.0]);
    assert!(cost[1] != 0.0 && cost[2] != 0.0, "{cost:?}");
}

/// A point on `r`'s top/bottom or left/right border, or anywhere.
fn tracing_point((x, y, w, h): Corners) -> impl Strategy<Value = Point> {
    prop_oneof![
        (x - 50..=x + w + 50, prop_oneof![Just(y), Just(y + h)]).prop_map(|(x, y)| pt(x, y)),
        (prop_oneof![Just(x), Just(x + w)], y - 50..=y + h + 50).prop_map(|(x, y)| pt(x, y)),
        free_point(),
    ]
}

/// A rect as integers, so a generator can range over its borders.
type Corners = (i32, i32, i32, i32);

fn border_rect() -> impl Strategy<Value = Corners> {
    (-100i32..=100, -100i32..=100, 0i32..=150, 0i32..=150)
}

fn to_rect((x, y, w, h): Corners) -> Rect {
    rect(x, y, w, h)
}

/// A path built from a rect's borders, that rect among the node borders.
fn tracing_scenario() -> impl Strategy<Value = (Vec<Point>, Vec<Rect>)> {
    (border_rect(), node_borders()).prop_flat_map(|(corners, extras)| {
        prop::collection::vec(tracing_point(corners), 0..=6).prop_map(move |path| {
            let mut borders = vec![to_rect(corners)];
            borders.extend(extras.iter().copied());
            (path, borders)
        })
    })
}

/// The collinear overlap of each axis-aligned segment with each rect border,
/// from the definition; integer geometry, so scaling at the end is exact.
fn reference_border_trace(path: &[Point], rects: &[Rect]) -> f64 {
    let mut total = 0.0;
    for w in path.windows(2) {
        let (a, b) = (w[0], w[1]);
        for r in rects {
            let span = if a.y == b.y && (a.y == r.y || a.y == r.y + r.h) {
                Some((a.x.min(b.x).max(r.x), a.x.max(b.x).min(r.x + r.w)))
            } else if a.x == b.x && (a.x == r.x || a.x == r.x + r.w) {
                Some((a.y.min(b.y).max(r.y), a.y.max(b.y).min(r.y + r.h)))
            } else {
                None
            };
            if let Some((lo, hi)) = span.filter(|(lo, hi)| hi > lo) {
                total += hi - lo;
            }
        }
    }
    total * COST_QUANTUM
}

fn reversed(rects: &[Rect]) -> Vec<Rect> {
    rects.iter().rev().copied().collect()
}

#[test]
fn border_tracing_is_a_deterministic_count_whatever_the_border_order() {
    check(tracing_scenario(), None, |(path, borders)| {
        let ink = self_penalty(&path, &[], &borders, &[])[BORDER_TRACING];
        prop_assert_eq!(ink, self_penalty(&path, &[], &borders, &[])[BORDER_TRACING]);
        prop_assert!(is_count(ink), "{ink}");
        prop_assert_eq!(ink, self_penalty(&path, &[], &reversed(&borders), &[])[BORDER_TRACING]);
        Ok(())
    });
}

#[test]
fn border_tracing_agrees_with_the_collinear_overlap_length() {
    let traced = Floor::new("a path tracing a border");
    check(tracing_scenario(), None, |(path, borders)| {
        let ink = self_penalty(&path, &[], &borders, &[])[BORDER_TRACING];
        traced.draw(ink > 0.0);
        prop_assert_eq!(ink, reference_border_trace(&path, &borders));
        Ok(())
    });
    // Measured 26 to 44 of 200.
    traced.assert(13);
}

/// A point on one of two chords strictly inside `r`, or anywhere.
///
/// Denser than `interiorPointArb`, which draws the interior coordinate per
/// point: two consecutive points then share it so rarely that a positive
/// chord arrived in 1 to 10 of 200 draws. Here the chords' coordinates are
/// drawn once per path, so consecutive points on one chord ARE a segment.
fn interior_point((x, y, w, h): Corners, (iy, ix): (i32, i32)) -> impl Strategy<Value = Point> {
    prop_oneof![
        (x - 50..=x + w + 50).prop_map(move |x| pt(x, iy)),
        (y - 50..=y + h + 50).prop_map(move |y| pt(ix, y)),
        free_point(),
    ]
}

/// The two chords' fixed coordinates: strictly inside `r` where it has an
/// inside, else on its edge.
fn chords((x, y, w, h): Corners) -> impl Strategy<Value = (i32, i32)> {
    let inside = |lo: i32, size: i32| if size >= 2 { lo + 1..=lo + size - 1 } else { lo..=lo };
    (inside(y, h), inside(x, w))
}

/// A path built from a rect's interior, with a container and a duplicate
/// sometimes beside it, as `endpointBodyInkScenarioArb`.
fn endpoint_scenario() -> impl Strategy<Value = (Vec<Point>, Vec<Rect>)> {
    let base = border_rect().prop_flat_map(|corners| (Just(corners), chords(corners)));
    (base, foreign_bodies(), any::<bool>(), any::<bool>()).prop_flat_map(
        |((corners, at), extras, wrapped, duplicated)| {
            let r = to_rect(corners);
            prop::collection::vec(interior_point(corners, at), 0..=6).prop_map(move |path| {
                let mut rects = Vec::new();
                if wrapped {
                    rects.push(Rect { x: r.x - 10.0, y: r.y - 10.0, w: r.w + 20.0, h: r.h + 20.0 });
                }
                rects.push(r);
                if duplicated {
                    rects.push(r);
                }
                rects.extend(extras.iter().copied());
                (path, rects)
            })
        },
    )
}

fn contains(outer: Rect, inner: Rect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.w <= outer.x + outer.w
        && inner.y + inner.h <= outer.y + outer.h
}

/// Strictly interior chord length, a rect PROPERLY containing another left
/// out, from the definition.
fn reference_endpoint_body_ink(path: &[Point], rects: &[Rect]) -> f64 {
    let priced: Vec<Rect> = (0..rects.len())
        .filter(|&i| {
            let r = rects[i];
            !(0..rects.len()).any(|j| j != i && contains(r, rects[j]) && !contains(rects[j], r))
        })
        .map(|i| rects[i])
        .collect();
    let mut total = 0.0;
    for w in path.windows(2) {
        let (a, b) = (w[0], w[1]);
        for r in &priced {
            let span = if a.y == b.y && a.y > r.y && a.y < r.y + r.h {
                Some((a.x.min(b.x).max(r.x), a.x.max(b.x).min(r.x + r.w)))
            } else if a.x == b.x && a.x > r.x && a.x < r.x + r.w {
                Some((a.y.min(b.y).max(r.y), a.y.max(b.y).min(r.y + r.h)))
            } else {
                None
            };
            if let Some((lo, hi)) = span.filter(|(lo, hi)| hi > lo) {
                total += hi - lo;
            }
        }
    }
    total * COST_QUANTUM
}

#[test]
fn endpoint_body_ink_is_a_deterministic_count_whatever_the_rect_order() {
    check(endpoint_scenario(), None, |(path, rects)| {
        let ink = self_penalty(&path, &[], &[], &rects)[ENDPOINT_BODY_INK];
        prop_assert_eq!(ink, self_penalty(&path, &[], &[], &rects)[ENDPOINT_BODY_INK]);
        prop_assert!(is_count(ink), "{ink}");
        prop_assert_eq!(ink, self_penalty(&path, &[], &[], &reversed(&rects))[ENDPOINT_BODY_INK]);
        Ok(())
    });
}

#[test]
fn endpoint_body_ink_agrees_with_the_strictly_interior_chord_length() {
    let inked = Floor::new("a path with ink strictly inside an endpoint rect");
    check(endpoint_scenario(), None, |(path, rects)| {
        let ink = self_penalty(&path, &[], &[], &rects)[ENDPOINT_BODY_INK];
        inked.draw(ink > 0.0);
        prop_assert_eq!(ink, reference_endpoint_body_ink(&path, &rects));
        Ok(())
    });
    // Measured 49 to 60 of 200.
    inked.assert(24);
}

/// One axis-aligned segment whose fixed coordinate is on a border, strictly
/// inside, or anywhere near `r`, as `axisSegmentArb`.
fn axis_segment((x, y, w, h): Corners) -> impl Strategy<Value = (Point, Point)> {
    let fixed = |lo: i32, size: i32| {
        let inside = if size >= 2 { lo + 1..=lo + size - 1 } else { lo..=lo };
        prop_oneof![prop_oneof![Just(lo), Just(lo + size)], inside, lo - 50..=lo + size + 50]
    };
    let along = |lo: i32, size: i32| (lo - 50..=lo + size + 50, lo - 50..=lo + size + 50);
    prop_oneof![
        (fixed(y, h), along(x, w)).prop_map(|(y, (x1, x2))| (pt(x1, y), pt(x2, y))),
        (fixed(x, w), along(y, h)).prop_map(|(x, (y1, y2))| (pt(x, y1), pt(x, y2))),
    ]
}

#[test]
fn border_tracing_and_endpoint_body_ink_never_charge_one_segment_twice() {
    let charged = Floor::new("a segment charged on either tier");
    let strategy =
        border_rect().prop_flat_map(|c| axis_segment(c).prop_map(move |(a, b)| (to_rect(c), a, b)));
    check(strategy, None, |(r, a, b)| {
        let border = self_penalty(&[a, b], &[], &[r], &[])[BORDER_TRACING];
        let inside = self_penalty(&[a, b], &[], &[], &[r])[ENDPOINT_BODY_INK];
        charged.draw(border > 0.0 || inside > 0.0);
        prop_assert!(border.min(inside) == 0.0, "border {border}, inside {inside}");
        Ok(())
    });
    // Measured 118 to 128 of 200.
    charged.assert(59);
}

/// Per-axis reversals from the definition: a step whose sign on an axis is
/// opposite to the last non-zero sign on that axis.
fn reference_reversal_count(path: &[Point]) -> f64 {
    let sign = |d: f64| {
        if d > 0.0 {
            1
        } else if d < 0.0 {
            -1
        } else {
            0
        }
    };
    let (mut count, mut last_x, mut last_y) = (0.0, 0, 0);
    for w in path.windows(2) {
        let (sx, sy) = (sign(w[1].x - w[0].x), sign(w[1].y - w[0].y));
        if sx != 0 {
            if sx == -last_x {
                count += 1.0;
            }
            last_x = sx;
        }
        if sy != 0 {
            if sy == -last_y {
                count += 1.0;
            }
            last_y = sy;
        }
    }
    count
}

fn reversals(path: &[Point]) -> f64 {
    self_penalty(path, &[], &[], &[])[PATH_REVERSAL]
}

#[test]
fn path_reversal_agrees_with_a_per_axis_reversal_count() {
    let reversing = Floor::new("a walk that reverses");
    check(orthogonal_path(), None, |path| {
        let count = reversals(&path);
        reversing.draw(count > 0.0);
        prop_assert_eq!(count, reversals(&path));
        prop_assert!(is_count(count), "{count}");
        prop_assert_eq!(count, reference_reversal_count(&path));
        Ok(())
    });
    // Measured 131 to 144 of 200.
    reversing.assert(65);
}

#[test]
fn path_reversal_is_invariant_under_translation() {
    check((orthogonal_path(), -500i32..=500, -500i32..=500), None, |(path, dx, dy)| {
        let (dx, dy) = (f64::from(dx), f64::from(dy));
        let moved: Vec<Point> = path.iter().map(|p| Point { x: p.x + dx, y: p.y + dy }).collect();
        prop_assert_eq!(reversals(&moved), reversals(&path));
        Ok(())
    });
}

#[test]
fn path_reversal_is_invariant_under_reversing_the_point_order() {
    check(orthogonal_path(), None, |path| {
        let back: Vec<Point> = path.iter().rev().copied().collect();
        prop_assert_eq!(reversals(&back), reversals(&path));
        Ok(())
    });
}

#[test]
fn path_reversal_never_exceeds_bend_count() {
    check(orthogonal_path(), None, |path| {
        prop_assert!(reversals(&path) <= bend_count(&path));
        Ok(())
    });
}

#[test]
fn has_repairable_problem_reads_every_tier_but_the_last() {
    let clean = Floor::new("a cost with nothing repairable");
    check(triple(), None, |t| {
        let cost = pair_penalty(t);
        let expected = cost.iter().take(TIERS - 1).any(|n| *n != 0.0);
        clean.draw(!expected);
        prop_assert_eq!(has_repairable_problem(&cost), expected);
        Ok(())
    });
    // Measured 32 to 42 of 200.
    clean.assert(16);
}
