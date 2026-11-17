//! Separation, and the two passes that keep alignment honest around it: the
//! overlap hop, the repair of an off-grid alignment whose anchor moved away,
//! and the margin a frame's members start at.

use whiteboard_det::math::{compare_numbers, js_max, js_min};
use whiteboard_edge_routing::geometry::Rect;

use super::axis::{AXES, Axis, on_some_anchor, round_to_grid};
use super::units::{
    Point, TIDY_BAND_PX, TIDY_GRID_PX, TIDY_MARGIN_PX, Unit, js_eq, overlaps_with_margin,
};
use crate::order::sorted_by;

/// How deep `unit` and `hit` overlap along `ax`: 0 or less when they miss.
fn penetration(ax: Axis, unit: &Rect, hit: &Rect) -> f64 {
    js_min(ax.at(unit, 1.0), ax.at(hit, 1.0)) - js_max(ax.near(unit), ax.near(hit))
}

/// Hops `unit` clear of everything in `occupied`, one obstacle at a time, in
/// the direction `forward` (right/down) or back along `ax`, landing on the first
/// clear grid spot past where it starts.
///
/// One pass over the obstacles in the order the hop meets them (nearest leading
/// edge first) is enough, and is what keeps a stack of identical boxes quadratic
/// rather than cubic. The hop is monotone and never changes the cross axis, so
/// an obstacle hopped past, or already behind, stays clear; and the first one
/// still AHEAD, out of reach, puts every later one out of reach too. Re-scanning
/// the whole set after every hop finds the same spot.
fn hop_clear(unit: &mut Unit, ax: Axis, forward: bool, occupied: &[Rect], from: f64) {
    // Hops land ON the grid, rounding AWAY from the collider so the clearance
    // never shrinks: off-grid spots would feed the next pass's banding and
    // unsettle the fixpoint.
    let snap_away = |v: f64| {
        let steps = (v - from) / TIDY_GRID_PX;
        from + if forward { steps.ceil() } else { steps.floor() } * TIDY_GRID_PX
    };
    let in_hop_order = sorted_by(occupied.to_vec(), |a, b| {
        if forward {
            compare_numbers(ax.near(a), ax.near(b))
        } else {
            compare_numbers(ax.at(b, 1.0), ax.at(a, 1.0))
        }
    });
    for hit in &in_hop_order {
        if !overlaps_with_margin(unit.bbox, *hit) {
            continue;
        }
        let next = snap_away(if forward {
            ax.at(hit, 1.0) + TIDY_MARGIN_PX
        } else {
            ax.near(hit) - TIDY_MARGIN_PX - ax.size(&unit.bbox)
        });
        let by = next - ax.near(&unit.bbox);
        ax.shift(unit, by);
    }
}

/// Deterministic sequential placement: immobile units occupy first; each movable
/// unit then hops along ONE axis (chosen from its first collision: smaller
/// penetration wins, ties go horizontal; direction away from the collider's
/// centre, ties right/down) until clear of everything placed so far.
pub(super) fn resolve_overlaps(units: &mut [Unit], origin: Point, floor: Option<Point>) {
    let mut occupied: Vec<Rect> = units.iter().filter(|u| !u.movable).map(|u| u.bbox).collect();
    for unit in units.iter_mut() {
        if !unit.movable {
            continue;
        }
        if let Some(hit) = occupied.iter().find(|r| overlaps_with_margin(unit.bbox, **r)).copied() {
            hop_away(unit, &hit, &occupied, origin, floor);
        }
        occupied.push(unit.bbox);
    }
}

/// One unit's hop from its first collision.
fn hop_away(unit: &mut Unit, hit: &Rect, occupied: &[Rect], origin: Point, floor: Option<Point>) {
    let ax = if penetration(Axis::X, &unit.bbox, hit) <= penetration(Axis::Y, &unit.bbox, hit) {
        Axis::X
    } else {
        Axis::Y
    };
    // Away from the collider's centre; a tie, or a NaN, goes forward.
    let backward = ax.at(&unit.bbox, 0.5) < ax.at(hit, 0.5);
    let forward = !backward;
    let start = ax.near(&unit.bbox);
    let from = ax.pick(origin.x, origin.y);
    hop_clear(unit, ax, forward, occupied, from);
    // Inside a frame a hop up or left stops at the margin: past it the frame
    // would grow up or left to follow, and its top-left is the one thing it
    // keeps. Hopping the other way finds room the frame can grow into.
    if !forward
        && let Some(floor) = floor
        && ax.near(&unit.bbox) < ax.pick(floor.x, floor.y)
    {
        let back = start - ax.near(&unit.bbox);
        ax.shift(unit, back);
        hop_clear(unit, ax, true, occupied, from);
    }
}

/// Whether `unit` is lined up on `ax` with any neighbour: the same anchors
/// `align_bands` aligns TO, read off where the units actually ended up rather
/// than from a second notion of "lined up". The NEAR edge counts as lined up
/// against any of a neighbour's three; a centre or far edge only against the
/// same anchor of one.
fn anchored(units: &[Unit], at: usize, ax: Axis) -> bool {
    let Some(unit) = units.get(at) else { return false };
    units.iter().enumerate().filter(|(i, _)| *i != at).any(|(_, o)| {
        ax.band_fractions().iter().any(|&fraction| {
            let anchors = if js_eq(fraction, 0.0) {
                vec![ax.at(&o.bbox, 0.0), ax.at(&o.bbox, 0.5), ax.at(&o.bbox, 1.0)]
            } else {
                vec![ax.at(&o.bbox, fraction)]
            };
            on_some_anchor(ax.at(&unit.bbox, fraction), &anchors)
        })
    })
}

/// An off-grid position is only earned while the neighbour it lines up with is
/// still there. This puts back the ones that are not.
///
/// `align_bands` may leave a unit off the grid deliberately, lined up on a
/// neighbour's centre or far edge, which is what a reader calls aligned and the
/// grid cannot express. The overlap pass then runs, which can move THAT
/// NEIGHBOUR, and the unit is left off-grid lined up with nothing. The
/// neighbour guard in `align_bands` cannot see this family: it asks whether the
/// SNAPPED unit would overlap, and here it is the ANCHOR that moves.
pub(super) fn snap_stale_anchors(units: &mut [Unit], origin: Point) {
    for at in 0..units.len() {
        if !units.get(at).is_some_and(|u| u.movable) {
            continue;
        }
        for ax in AXES {
            let Some(unit) = units.get(at) else { continue };
            let here = ax.near(&unit.bbox);
            let snapped = round_to_grid(here, ax.pick(origin.x, origin.y));
            if js_eq(snapped, here) || anchored(units, at, ax) {
                continue;
            }
            // The snap runs after the last separation, so it may not undo it:
            // rounding can close a margin the overlap pass left exactly open.
            if closes_a_margin(units, at, &ax.moved(&unit.bbox, snapped - here)) {
                continue;
            }
            if let Some(unit) = units.get_mut(at) {
                ax.shift(unit, snapped - here);
            }
        }
    }
}

/// Whether `moved`, the box of unit `at` after a shift, is within the margin of
/// a neighbour it was clear of before.
fn closes_a_margin(units: &[Unit], at: usize, moved: &Rect) -> bool {
    let Some(unit) = units.get(at) else { return false };
    units.iter().enumerate().filter(|(i, _)| *i != at).any(|(_, o)| {
        overlaps_with_margin(*moved, o.bbox) && !overlaps_with_margin(unit.bbox, o.bbox)
    })
}

/// The anchors a frame's level holds that the margin rule cannot move.
#[derive(Debug, Default)]
pub(super) struct Outside {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

/// Inside a frame: pulls every movable unit onto the margin it starts at.
///
/// An ANCHOR rather than only a floor: a member hugging the frame's top or left
/// edge is moved IN to it rather than the frame grown around it, and one already
/// clear of it but within `TIDY_BAND_PX` is pulled ONTO it. That is what makes
/// frames that line up hold members that line up.
pub(super) fn apply_floor(units: &mut [Unit], floor: Point, outside: &Outside) {
    for unit in units.iter_mut().filter(|u| u.movable) {
        for ax in AXES {
            let target = ax.pick(floor.x, floor.y);
            let at = ax.near(&unit.bbox);
            if at - target >= TIDY_BAND_PX {
                continue;
            }
            // Already lined up with something the frame does not hold: a
            // neighbour the margin rule cannot move IS the row, wherever it
            // sits. Only the ANCHOR yields; a member outside the margin is
            // still moved in, which is the floor's own job.
            if at >= target && on_some_anchor(at, ax.pick(&outside.x, &outside.y)) {
                continue;
            }
            ax.shift(unit, target - at);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn unit(x: f64, y: f64) -> Unit {
        Unit {
            root: 0,
            members: vec![0],
            bbox: Rect { x, y, w: 10.0, h: 10.0 },
            movable: true,
            dx: 0.0,
            dy: 0.0,
        }
    }

    const ORIGIN: Point = Point { x: 0.0, y: 0.0 };

    #[test]
    fn a_snap_that_would_close_the_margin_to_a_neighbour_is_not_made() {
        // Lined up with nothing, 5 and 47 both round onto the grid, to 8 and 48:
        // a gap of 30 where 32 was left.
        let mut units = vec![unit(5.0, 0.0), unit(47.0, 0.0)];
        snap_stale_anchors(&mut units, ORIGIN);
        let gap = units[1].bbox.x - (units[0].bbox.x + units[0].bbox.w);
        assert!(gap >= TIDY_MARGIN_PX, "gap {gap}");
        // The one that can snap clear still does.
        assert!(js_eq(units[1].bbox.x, 48.0));
    }

    #[test]
    fn a_snap_toward_a_neighbour_is_judged_by_the_distance_it_really_moves() {
        // The left one snaps to -32 (away from its neighbour); the right one
        // would snap to 8, 3px toward the box on its left, and closes the margin.
        let mut units = vec![unit(-31.0, 0.0), unit(11.0, 0.0)];
        snap_stale_anchors(&mut units, ORIGIN);
        assert!(js_eq(units[0].bbox.x, -32.0));
        assert!(js_eq(units[1].bbox.x, 11.0));
    }

    #[test]
    fn a_snap_clear_of_every_neighbour_is_made() {
        let mut units = vec![unit(5.0, 0.0), unit(200.0, 0.0)];
        snap_stale_anchors(&mut units, ORIGIN);
        assert!(js_eq(units[0].bbox.x, 8.0));
    }

    #[test]
    fn a_unit_already_inside_the_margin_of_a_neighbour_still_snaps() {
        // Nothing the snap does closes a margin that was never open.
        let mut units = vec![unit(5.0, 0.0), unit(20.0, 0.0)];
        snap_stale_anchors(&mut units, ORIGIN);
        assert!(js_eq(units[0].bbox.x, 8.0));
    }
}
