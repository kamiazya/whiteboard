//! What the router's two detour searches promise whatever the board, as
//! properties: every waypoint stays inside the bound the obstacle prune
//! assumes, and a corner detour crosses nothing it was told to avoid.
//!
//! The TypeScript twins are `detour-reach.properties.test.ts` and
//! `straight-detour.properties.test.ts`. The leg test is written here from the
//! definition (a Liang-Barsky clip against the open rect), not borrowed from
//! the router, so a broken clearance test cannot agree with itself.

use whiteboard_edge_routing::edge_router::{DETOUR_REACH_PX, detour_candidates};
use whiteboard_edge_routing::geometry::{Point, Rect};
use whiteboard_edge_routing::straight_detour::{DetourObstacle, corner_detour};
use whiteboard_proptest::proptest::prelude::{Strategy, prop, prop_assert, prop_assert_eq};
use whiteboard_proptest::{Floor, check};
// On wasm32 the same tests run under Node (QR-21 layer 3).
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn point(lo: i32, hi: i32) -> impl Strategy<Value = Point> {
    (lo..=hi, lo..=hi).prop_map(|(x, y)| Point { x: f64::from(x), y: f64::from(y) })
}

#[test]
fn every_detour_waypoint_lies_within_the_ends_and_the_region_grown_by_the_reach() {
    let beyond = Floor::new("a waypoint outside the box of the two ends");
    let region = (-400i32..=400, -400i32..=400, 0i32..=600, 0i32..=600).prop_map(|(x, y, w, h)| {
        Rect { x: f64::from(x), y: f64::from(y), w: f64::from(w), h: f64::from(h) }
    });
    check((point(-500, 500), point(-500, 500), region), Some(300), |(start, end, region)| {
        let min_x = start.x.min(end.x).min(region.x - DETOUR_REACH_PX);
        let max_x = start.x.max(end.x).max(region.x + region.w + DETOUR_REACH_PX);
        let min_y = start.y.min(end.y).min(region.y - DETOUR_REACH_PX);
        let max_y = start.y.max(end.y).max(region.y + region.h + DETOUR_REACH_PX);
        let mut outside_ends = false;
        for path in detour_candidates(start, end, region) {
            for p in path {
                prop_assert!(p.x >= min_x && p.x <= max_x, "x {} outside {min_x}..{max_x}", p.x);
                prop_assert!(p.y >= min_y && p.y <= max_y, "y {} outside {min_y}..{max_y}", p.y);
                outside_ends |= p.x < start.x.min(end.x)
                    || p.x > start.x.max(end.x)
                    || p.y < start.y.min(end.y)
                    || p.y > start.y.max(end.y);
            }
        }
        beyond.draw(outside_ends);
        Ok(())
    });
    // Without it the region's half of the bound is never what holds a point
    // in. Measured 295 to 297 of 300.
    beyond.assert(250);
}

/// Whether `a`->`b` runs through the inside of `r` for some length. Touching
/// its boundary (a corner, or a run along a side) is not entering it.
fn meets(a: Point, b: Point, r: Rect) -> bool {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
    for (p, q) in [(-dx, a.x - r.x), (dx, r.x + r.w - a.x), (-dy, a.y - r.y), (dy, r.y + r.h - a.y)]
    {
        if p == 0.0 {
            if q <= 0.0 {
                return false;
            }
            continue;
        }
        let t = q / p;
        if p < 0.0 {
            t0 = t0.max(t);
        } else {
            t1 = t1.min(t);
        }
        if t0 >= t1 {
            return false;
        }
    }
    true
}

fn inside(r: Rect, p: Point) -> bool {
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

const MARGIN: f64 = 8.0;

/// Each body with its margin band as the block a route keeps out of.
fn obstacles_of(bodies: &[Rect]) -> Vec<DetourObstacle> {
    bodies
        .iter()
        .map(|&body| DetourObstacle {
            body,
            block: Rect {
                x: body.x - MARGIN,
                y: body.y - MARGIN,
                w: body.w + 2.0 * MARGIN,
                h: body.h + 2.0 * MARGIN,
            },
            escapable: true,
        })
        .collect()
}

/// Whether `turn` is within `DETOUR_REACH_PX` of some body.
fn within_reach(turn: Point, bodies: &[Rect]) -> bool {
    bodies.iter().any(|b| {
        turn.x >= b.x - DETOUR_REACH_PX
            && turn.x <= b.x + b.w + DETOUR_REACH_PX
            && turn.y >= b.y - DETOUR_REACH_PX
            && turn.y <= b.y + b.h + DETOUR_REACH_PX
    })
}

#[test]
fn a_corner_detour_crosses_nothing_and_turns_within_the_prune_reach() {
    let detoured = Floor::new("a route with a turn");
    // Dense on purpose: boxes up to a third of the field, so most draws put
    // several in the line's way and some overlap.
    let body = (0i32..=500, 0i32..=500, 10i32..=200, 10i32..=200).prop_map(|(x, y, w, h)| Rect {
        x: f64::from(x),
        y: f64::from(y),
        w: f64::from(w),
        h: f64::from(h),
    });
    let bodies = prop::collection::vec(body, 1..=8);
    check((point(-50, 650), point(-50, 650), bodies), Some(400), |(start, end, bodies)| {
        // An end inside a body cannot be routed around; the router drops such
        // a body before asking.
        let free: Vec<Rect> =
            bodies.into_iter().filter(|b| !inside(*b, start) && !inside(*b, end)).collect();
        let obstacles = obstacles_of(&free);
        let Some(path) = corner_detour(start, end, &obstacles, DETOUR_REACH_PX) else {
            detoured.draw(false);
            return Ok(());
        };
        detoured.draw(path.len() > 2);
        prop_assert_eq!(path.first(), Some(&start));
        prop_assert_eq!(path.last(), Some(&end));
        for leg in path.windows(2) {
            let (a, b) = (leg[0], leg[1]);
            for o in &obstacles {
                let escaping = inside(o.block, a) || inside(o.block, b);
                let avoided = if escaping { o.body } else { o.block };
                prop_assert!(!meets(a, b, avoided), "{a:?}->{b:?} runs through {avoided:?}");
            }
        }
        for turn in &path[1..path.len() - 1] {
            prop_assert!(
                within_reach(*turn, &free),
                "the turn {turn:?} is beyond every body's reach"
            );
        }
        Ok(())
    });
    // Measured 139 to 170 of 400 (the TypeScript, 129).
    detoured.assert(100);
}
