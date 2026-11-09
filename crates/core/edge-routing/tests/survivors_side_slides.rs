//! Concrete answers of the side-slide helpers that cargo-mutants showed no
//! other test pinned. Every expected value is what canvas-render's
//! `side-slides.ts` returns for the same input.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::edge_geometry::{Side, outward_normal};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::side_slides::{
    FacingEnds, slid_for_approach, slide_along_side, try_zero_bend_slide,
};

const fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// A top side narrower than twice the corner inset keeps half its WIDTH at
/// each end, so its span closes to the one midpoint and a slide lands there.
#[test]
fn a_narrow_side_insets_by_half_its_width_and_slides_only_to_its_midpoint() {
    let rect = Rect { x: 0.0, y: 0.0, w: 8.0, h: 40.0 };
    assert_eq!(slide_along_side(p(2.0, 0.0), rect, Side::Top, p(4.0, -30.0)), Some(p(4.0, 0.0)));
    assert_eq!(slide_along_side(p(2.0, 0.0), rect, Side::Top, p(3.0, -30.0)), None);
    assert_eq!(slide_along_side(p(2.0, 0.0), rect, Side::Top, p(5.0, -30.0)), None);
}

/// Facing is strict: an arrival exactly level with the departure's side,
/// neither ahead of nor behind it, has no straight run between them.
#[test]
fn ends_level_with_the_departure_side_do_not_face() {
    let ends = FacingEnds {
        start: p(100.0, 20.0),
        end: p(100.0, 40.0),
        from_side: Side::Right,
        to_side: Side::Left,
        from_rect: Rect { x: 0.0, y: 0.0, w: 100.0, h: 60.0 },
        to_rect: Rect { x: 100.0, y: 0.0, w: 100.0, h: 60.0 },
    };
    assert_eq!(try_zero_bend_slide(&ends, &[]), None);
}

/// Two spans that share only one coordinate still share a lane: the run is
/// slid onto that coordinate.
#[test]
fn spans_meeting_at_one_coordinate_share_a_lane_there() {
    let ends = FacingEnds {
        start: p(100.0, 20.0),
        end: p(200.0, 70.0),
        from_side: Side::Right,
        to_side: Side::Left,
        from_rect: Rect { x: 0.0, y: 0.0, w: 100.0, h: 60.0 },
        to_rect: Rect { x: 200.0, y: 40.0, w: 100.0, h: 60.0 },
    };
    assert_eq!(try_zero_bend_slide(&ends, &[]), Some(vec![p(100.0, 50.0), p(200.0, 50.0)]));
}

/// A same-side or opposite-side pair keeps its departure anchor as given,
/// whatever normal it is handed: even a `-0` coordinate, which sliding it by
/// `0 * shortfall` would turn into `+0`, and a sideways normal, which would
/// move it.
#[test]
fn a_parallel_pair_keeps_its_departure_anchor_untouched() {
    let from_rect = Rect { x: -50.0, y: 0.0, w: 100.0, h: 60.0 };
    for (to_side, end) in [(Side::Top, p(10.0, 10.0)), (Side::Bottom, p(10.0, -10.0))] {
        let ends = FacingEnds {
            start: p(-0.0, 0.0),
            end,
            from_side: Side::Top,
            to_side,
            from_rect,
            to_rect: from_rect,
        };
        let slid = slid_for_approach(&ends, outward_normal(to_side));
        assert_eq!((slid.x.to_bits(), slid.y.to_bits()), ((-0.0_f64).to_bits(), 0.0_f64.to_bits()));
        assert_eq!(slid_for_approach(&ends, p(-1.0, 0.0)), p(-0.0, 0.0));
    }
}
