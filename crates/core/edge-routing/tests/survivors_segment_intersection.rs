//! Concrete answers of `segment_intersection` that cargo-mutants showed no
//! other test pinned. Every expected value is what canvas-render's
//! `segmentIntersection` returns for the same four points.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_edge_routing::segment_intersection::segment_intersection;

type Case = ([f64; 8], Option<(f64, f64)>);

fn answer(c: [f64; 8]) -> Option<(f64, f64)> {
    let [ax, ay, bx, by, cx, cy, dx, dy] = c;
    let p = |x, y| Point { x, y };
    segment_intersection(p(ax, ay), p(bx, by), p(cx, cy), p(dx, dy)).map(|q| (q.x, q.y))
}

fn assert_cases(cases: &[Case]) {
    for &(c, expected) in cases {
        let got = answer(c);
        let bits = |o: Option<(f64, f64)>| o.map(|(x, y)| (x.to_bits(), y.to_bits()));
        assert_eq!(bits(got), bits(expected), "{c:?}: {got:?}, expected {expected:?}");
    }
}

/// Oblique segments away from the origin, so neither term of a cross
/// product and neither offset from `a1` is zero.
#[test]
fn oblique_crossings_away_from_the_origin_meet_where_the_typescript_says() {
    assert_cases(&[
        ([3.0, 7.0, 43.0, 37.0, 5.0, 40.0, 41.0, 4.0], Some((23.0, 22.0))),
        ([100.0, 0.0, 120.0, 20.0, 100.0, 20.0, 120.0, 0.0], Some((110.0, 10.0))),
        (
            [-17.0, 5.0, 23.0, -11.0, -9.0, -20.0, 13.0, 19.0],
            Some((1.033_472_803_347_28, -2.213_389_121_338_912_5)),
        ),
        (
            [2.5, -3.25, 40.75, 18.5, 10.0, 30.0, 30.0, -12.0],
            Some((20.861_498_897_869_215, 7.190_852_314_474_652)),
        ),
        (
            [50.0, 50.0, 10.0, 90.0, 15.0, 60.0, 48.0, 95.0],
            Some((27.132_352_941_176_47, 72.867_647_058_823_54)),
        ),
        (
            [7.0, 7.0, 31.0, -29.0, -3.0, -14.0, 40.0, 9.0],
            Some((14.691_428_571_428_57, -4.537_142_857_142_857)),
        ),
        (
            [0.0, 0.0, 40.0, 30.0, 18.0, 20.0, 30.0, 8.0],
            Some((21.714_285_714_285_71, 16.285_714_285_714_285)),
        ),
        // b ends just short of the line a runs along.
        ([0.0, 0.0, 40.0, 40.0, 19.0, 21.5, 25.0, 40.0], None),
    ]);
}

/// The second segment's lines meet the first, but the segment stops short
/// of it on either side.
#[test]
fn a_crossing_beyond_either_end_of_the_second_segment_is_refused() {
    assert_cases(&[
        ([0.0, 0.0, 20.0, 0.0, 10.0, 1.0, 10.0, 5.0], None),
        ([0.0, 0.0, 20.0, 0.0, 10.0, -5.0, 10.0, -1.0], None),
    ]);
}

/// `END_CLEARANCE_PX` is 6: a crossing exactly 6 from either end of the
/// first segment keeps its hop, one closer does not.
#[test]
fn the_end_clearance_is_six_pixels_and_six_exactly_is_enough() {
    assert_cases(&[
        ([0.0, 0.0, 20.0, 0.0, 5.0, -5.0, 5.0, 5.0], None),
        ([0.0, 0.0, 16.0, 0.0, 6.0, -4.0, 6.0, 4.0], Some((6.0, 0.0))),
        ([0.0, 0.0, 16.0, 0.0, 10.0, -4.0, 10.0, 4.0], Some((10.0, 0.0))),
        ([0.0, 0.0, 16.0, 0.0, 13.0, -4.0, 13.0, 4.0], None),
    ]);
}

/// A first segment whose length overflows makes the clearance products NaN,
/// which pass both comparisons; the crossing at its very start must still be
/// refused by the range test on `t`.
#[test]
fn a_crossing_at_the_start_of_an_overflowing_segment_is_refused() {
    assert_cases(&[([0.0, 0.0, 1.5e308, 1.5e308, -1.0, 1.0, 1.0, -1.0], None)]);
}
